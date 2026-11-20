import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import {
  AssetRegistry,
  BudgetController,
  CollateralLending,
  MockERC20,
  MockERC4907,
  MultiSigGuardian,
  RevenueSplitter,
  TreasuryVesting,
} from "../typechain-types";

describe("ZeroVault Protocol-Wide Fuzz & Stateful Scenario Suite (Pre-Testnet)", function () {
  this.timeout(120000); // Allow generous time for 200+ fuzz runs

  const DAY = 24 * 60 * 60;
  const INITIAL_DELAY = 2 * DAY;
  const GRACE_PERIOD_TL = 14 * DAY;

  function createPrng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s;
    };
  }

  function randRange(nextRand: () => number, min: number, max: number): number {
    return min + (nextRand() % (max - min + 1));
  }

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // =========================================================================
  // 1. TIMELOCK + EMERGENCY PAUSE + ROLEMANAGER FUZZING (50 runs)
  // =========================================================================
  it("Fuzz 1: Timelock, EmergencyPause & RoleManager across 50 randomized operations", async function () {
    const [, admin, operator, executor, guardian, budgetManager, outsider] =
      await ethers.getSigners();

    const { emergencyPause, timelock, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const nextRand = createPrng(1001);
    const sig = "setDelay(uint256)";

    for (let i = 0; i < 50; i++) {
      const currentDelay = Number(await timelock.delay());
      const newDelay = randRange(nextRand, DAY, 30 * DAY);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newDelay]);
      const salt = ethers.id(`tl-fuzz-${i}-${nextRand()}`);
      const now = await currentTimestamp();

      // 25% chance to test invalid eta (< currentDelay)
      if (nextRand() % 4 === 0) {
        const badEta = now + randRange(nextRand, 0, currentDelay - 10);
        await expect(
          timelock.connect(operator).queueTransaction(addresses.timelock, 0, sig, data, badEta, salt)
        ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidDelay");
        continue;
      }

      const eta = now + currentDelay + randRange(nextRand, 60, 3600);
      const opId = await timelock.computeOperationId(addresses.timelock, 0, sig, data, eta, salt);

      // Outsider or executor can never queue
      const badQueuer = nextRand() % 2 === 0 ? outsider : executor;
      await expect(
        timelock.connect(badQueuer).queueTransaction(addresses.timelock, 0, sig, data, eta, salt)
      ).to.be.revertedWithCustomError(timelock, "Timelock__Unauthorized");

      // Operator queues validly
      await timelock.connect(operator).queueTransaction(addresses.timelock, 0, sig, data, eta, salt);
      expect(await timelock.getOperationState(opId)).to.equal(1); // Queued

      // Premature execution always fails
      await expect(
        timelock.connect(executor).executeTransaction(addresses.timelock, 0, sig, data, eta, salt)
      ).to.be.revertedWithCustomError(timelock, "Timelock__TxNotReady");

      const scenario = nextRand() % 4;
      if (scenario === 0) {
        // Cancel while paused
        await emergencyPause.connect(guardian).pause();
        await timelock.connect(guardian).cancelTransaction(opId);
        expect(await timelock.getOperationState(opId)).to.equal(4); // Cancelled
        await emergencyPause.connect(admin).unpause();
        await expect(
          timelock.connect(executor).executeTransaction(addresses.timelock, 0, sig, data, eta, salt)
        ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidState");
      } else if (scenario === 1) {
        // Expire past grace period
        await advanceTime(eta - now + GRACE_PERIOD_TL + 60);
        expect(await timelock.getOperationState(opId)).to.equal(5); // Expired
        await expect(
          timelock.connect(executor).executeTransaction(addresses.timelock, 0, sig, data, eta, salt)
        ).to.be.revertedWithCustomError(timelock, "Timelock__TxExpired");
      } else {
        // Advance past eta and execute validly, then verify replay is impossible
        await advanceTime(eta - now + 10);
        expect(await timelock.getOperationState(opId)).to.equal(2); // Ready

        // Operator cannot execute
        await expect(
          timelock.connect(operator).executeTransaction(addresses.timelock, 0, sig, data, eta, salt)
        ).to.be.revertedWithCustomError(timelock, "Timelock__Unauthorized");

        await timelock.connect(executor).executeTransaction(addresses.timelock, 0, sig, data, eta, salt);
        expect(await timelock.getOperationState(opId)).to.equal(3); // Executed
        expect(await timelock.delay()).to.equal(newDelay);

        // Replay must fail
        await expect(
          timelock.connect(executor).executeTransaction(addresses.timelock, 0, sig, data, eta, salt)
        ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidState");
      }
    }
  });

  // =========================================================================
  // 2. TREASURY + VAULT + ASSETREGISTRY + BUDGETCONTROLLER STATEFUL FUZZ (40 rounds)
  // =========================================================================
  it("Fuzz 2: Treasury, Vault, AssetRegistry & BudgetController conservation across 40 randomized rounds", async function () {
    const [, admin, operator, executor, guardian, budgetManager, depositor, recipient] =
      await ethers.getSigners();

    const { timelock, vault, treasury, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const registry = (await (
      await ethers.getContractFactory("AssetRegistry")
    ).deploy(addresses.roleManager, true)) as unknown as AssetRegistry;
    await vault.connect(admin).setAssetRegistry(await registry.getAddress());

    const budget = (await (
      await ethers.getContractFactory("BudgetController")
    ).deploy(addresses.roleManager)) as unknown as BudgetController;
    await budget.connect(admin).initializeTreasury(addresses.treasury);
    await treasury.connect(admin).setBudgetController(await budget.getAddress());

    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Fuzz RWA",
      "fRWA"
    )) as unknown as MockERC20;
    const tokenAddr = await token.getAddress();

    const SINGLE_CAP = ethers.parseEther("500");
    const EPOCH_CAP = ethers.parseEther("1200");
    const EPOCH_DURATION = 5 * DAY;

    await registry.connect(budgetManager).registerAsset(tokenAddr, 2, SINGLE_CAP); // RWA_ERC20
    await budget.connect(budgetManager).configureBudget(tokenAddr, EPOCH_CAP, EPOCH_DURATION);

    const nextRand = createPrng(2002);
    let totalTokenDeposited = 0n;
    let totalTokenWithdrawn = 0n;

    for (let r = 0; r < 40; r++) {
      // Random deposit 100..600 tokens
      const dep = BigInt(randRange(nextRand, 100, 600)) * ethers.parseEther("1");
      await token.mint(depositor.address, dep);
      await token.connect(depositor).approve(addresses.treasury, dep);
      await treasury.connect(depositor).depositERC20(tokenAddr, dep);
      totalTokenDeposited += dep;

      // Random withdrawal attempt 50..700 tokens
      const wAmt = BigInt(randRange(nextRand, 50, 700)) * ethers.parseEther("1");
      const currentVaultBal = totalTokenDeposited - totalTokenWithdrawn;
      const remainingEpoch = await budget.remainingBudget(tokenAddr);

      // Occasionally freeze and unfreeze
      if (nextRand() % 7 === 0) {
        await registry.connect(guardian).freezeAsset(tokenAddr);
        await expect(
          treasury.connect(operator).requestERC20Withdrawal(tokenAddr, recipient.address, ethers.parseEther("10"), "Frozen")
        ).to.be.revertedWithCustomError(registry, "AssetRegistry__AssetFrozen");
        await registry.connect(admin).unfreezeAsset(tokenAddr);
      }

      if (wAmt > currentVaultBal) {
        await expect(
          treasury.connect(operator).requestERC20Withdrawal(tokenAddr, recipient.address, wAmt, "OverBal")
        ).to.be.revertedWithCustomError(treasury, "Treasury__InsufficientBalance");
      } else if (wAmt > SINGLE_CAP) {
        await expect(
          treasury.connect(operator).requestERC20Withdrawal(tokenAddr, recipient.address, wAmt, "OverCap")
        ).to.be.revertedWithCustomError(registry, "AssetRegistry__ExceedsWithdrawalCap");
      } else if (wAmt > remainingEpoch) {
        await expect(
          treasury.connect(operator).requestERC20Withdrawal(tokenAddr, recipient.address, wAmt, "OverEpoch")
        ).to.be.revertedWithCustomError(budget, "BudgetController__EpochLimitExceeded");
        // Advance to next epoch so budget resets
        await advanceTime(EPOCH_DURATION);
      } else {
        const reqId = await treasury.nextRequestId();
        await treasury.connect(operator).requestERC20Withdrawal(tokenAddr, recipient.address, wAmt, `R${r}`);

        const sig = "executeWithdrawal(uint256)";
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [reqId]);
        const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
        const salt = ethers.id(`tr-fuzz-${r}`);

        await timelock.connect(operator).queueTransaction(addresses.treasury, 0, sig, data, eta, salt);
        await advanceTime(INITIAL_DELAY + 120);

        const remAtExec = await budget.remainingBudget(tokenAddr);
        if (wAmt <= remAtExec) {
          await timelock.connect(executor).executeTransaction(addresses.treasury, 0, sig, data, eta, salt);
          totalTokenWithdrawn += wAmt;
        }
      }

      // Strict conservation invariant
      expect(await vault.getERC20Balance(tokenAddr)).to.equal(totalTokenDeposited - totalTokenWithdrawn);
      expect(await token.balanceOf(addresses.treasury)).to.equal(0n);
    }
  });

  // =========================================================================
  // 3. TREASURY VESTING MATHEMATICAL FUZZING (40 randomized schedules)
  // =========================================================================
  it("Fuzz 3: TreasuryVesting monotonicity and exact accounting across 40 randomized schedules", async function () {
    const [, admin, operator, executor, guardian, budgetManager, beneficiary] =
      await ethers.getSigners();

    const { addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const vesting = (await (
      await ethers.getContractFactory("TreasuryVesting")
    ).deploy(addresses.roleManager, addresses.emergencyPause, executor.address)) as unknown as TreasuryVesting;
    const vestingAddr = await vesting.getAddress();

    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Vest Token",
      "VST"
    )) as unknown as MockERC20;
    const tokenAddr = await token.getAddress();

    const nextRand = createPrng(3003);
    const slices = [1, 7 * DAY, 30 * DAY, 90 * DAY];

    for (let i = 1; i <= 40; i++) {
      const total = BigInt(randRange(nextRand, 100, 100000)) * ethers.parseEther("1") + BigInt(randRange(nextRand, 0, 999));
      const tgeBps = randRange(nextRand, 0, 4000);
      const tgeAmount = (total * BigInt(tgeBps)) / 10000n;
      const cliffDuration = randRange(nextRand, 0, 180) * DAY;
      const slicePeriod = slices[nextRand() % slices.length];
      const duration = Math.max(slicePeriod, randRange(nextRand, 1, 12) * 30 * DAY);
      const revocable = nextRand() % 2 === 0;
      const startTime = await currentTimestamp();

      await token.mint(admin.address, total);
      await token.connect(admin).approve(vestingAddr, total);

      await vesting.connect(admin).createSchedule({
        token: tokenAddr,
        beneficiary: beneficiary.address,
        totalAmount: total,
        tgeAmount,
        startTime,
        cliffDuration,
        duration,
        slicePeriod,
        revocable,
      });

      const benBefore = await token.balanceOf(beneficiary.address);
      const vaultBefore = await token.balanceOf(addresses.vault);

      // Check before cliff if cliff > 0
      if (cliffDuration > DAY) {
        await advanceTime(Math.floor(cliffDuration / 2));
        expect(await vesting.vestedAmount(i)).to.equal(tgeAmount);
      }

      // Advance to random point mid-vesting
      const jump = cliffDuration + randRange(nextRand, 1, duration);
      await advanceTime(jump);

      const vMid = await vesting.vestedAmount(i);
      expect(vMid).to.be.gte(tgeAmount);
      expect(vMid).to.be.lte(total);

      const claimableMid = await vesting.claimableAmount(i);
      if (claimableMid > 0n) {
        await vesting.connect(beneficiary).claim(i);
      }

      if (revocable && nextRand() % 2 === 0) {
        await vesting.connect(executor).revokeSchedule(i, addresses.vault);
        const remClaimable = await vesting.claimableAmount(i);
        if (remClaimable > 0n) {
          await vesting.connect(beneficiary).claim(i);
        }
      } else {
        await advanceTime(duration + DAY);
        expect(await vesting.vestedAmount(i)).to.equal(total);
        const rem = await vesting.claimableAmount(i);
        if (rem > 0n) {
          await vesting.connect(beneficiary).claim(i);
        }
      }

      const benDelta = (await token.balanceOf(beneficiary.address)) - benBefore;
      const vaultDelta = (await token.balanceOf(addresses.vault)) - vaultBefore;

      // Exact zero-wei conservation invariant!
      expect(benDelta + vaultDelta).to.equal(total);
    }
  });

  // =========================================================================
  // 4. REVENUE SPLITTER ZERO-DUST FUZZING (40 randomized splits & amounts)
  // =========================================================================
  it("Fuzz 4: RevenueSplitter zero-wei dust conservation across 40 randomized splits & odd amounts", async function () {
    const signers = await ethers.getSigners();
    const [, admin, operator, executor, guardian, budgetManager, payer] = signers;
    const poolRecipients = signers.slice(7, 15); // 8 distinct recipients

    const { addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const SplitterFactory = await ethers.getContractFactory("RevenueSplitter");
    const nextRand = createPrng(4004);

    for (let i = 0; i < 40; i++) {
      const count = randRange(nextRand, 1, poolRecipients.length);
      let remainingBps = 10000;
      const splits: { recipient: string; bps: number }[] = [];

      for (let j = 0; j < count; j++) {
        let bps: number;
        if (j === count - 1) {
          bps = remainingBps;
        } else {
          const maxBps = remainingBps - (count - 1 - j);
          bps = randRange(nextRand, 1, Math.max(1, Math.floor(maxBps / 2)));
          remainingBps -= bps;
        }
        splits.push({ recipient: poolRecipients[j].address, bps });
      }

      const splitter = (await SplitterFactory.deploy(
        addresses.emergencyPause,
        addresses.timelock,
        splits
      )) as unknown as RevenueSplitter;
      const splitterAddr = await splitter.getAddress();

      // Send odd wei amount (1 wei .. 2 ETH + odd wei)
      const oddWei = BigInt(randRange(nextRand, 1, 1000000)) * 1000000000000n + BigInt(randRange(nextRand, 1, 999));
      await payer.sendTransaction({ to: splitterAddr, value: oddWei });
      await splitter.distributeETH();

      let totalClaimed = 0n;
      for (const s of splits) {
        const pending = await splitter.pendingETH(s.recipient);
        if (pending > 0n) {
          await splitter.claimETH(s.recipient);
          totalClaimed += pending;
        }
      }

      // Zero wei dust left trapped in contract!
      expect(totalClaimed).to.equal(oddWei);
      expect(await ethers.provider.getBalance(splitterAddr)).to.equal(0n);
    }
  });

  // =========================================================================
  // 5. MULTISIG GUARDIAN M-OF-N FUZZING (30 randomized voting scenarios)
  // =========================================================================
  it("Fuzz 5: MultiSigGuardian M-of-N threshold enforcement across 30 randomized scenarios", async function () {
    const signers = await ethers.getSigners();
    const [, admin, operator, executor, guardian, budgetManager, outsider] = signers;
    const msSigners = signers.slice(7, 12); // 5 signers

    const { addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const MultiSigFactory = await ethers.getContractFactory("MultiSigGuardian");
    const nextRand = createPrng(5005);

    for (let i = 0; i < 30; i++) {
      const threshold = randRange(nextRand, 1, msSigners.length);
      const ms = (await MultiSigFactory.deploy(
        addresses.emergencyPause,
        msSigners.map((s) => s.address),
        threshold
      )) as unknown as MultiSigGuardian;
      const msAddr = await ms.getAddress();

      const newThreshold = randRange(nextRand, 1, msSigners.length);
      const data = ms.interface.encodeFunctionData("changeThreshold", [newThreshold]);

      // Outsider cannot propose
      await expect(
        ms.connect(outsider).proposeAction(msAddr, 0, data, "Bad")
      ).to.be.revertedWithCustomError(ms, "MultiSigGuardian__NotSigner");

      // Signer 0 proposes (confirmations = 1)
      await ms.connect(msSigners[0]).proposeAction(msAddr, 0, data, `Fuzz-${i}`);

      let confirmations = 1;
      for (let sIdx = 1; sIdx < threshold; sIdx++) {
        // Must fail while below threshold
        await expect(ms.connect(msSigners[0]).executeAction(1)).to.be.revertedWithCustomError(
          ms,
          "MultiSigGuardian__InsufficientConfirmations"
        );
        await ms.connect(msSigners[sIdx]).confirmAction(1);
        confirmations++;

        // Random revoke + re-confirm check
        if (nextRand() % 3 === 0) {
          await ms.connect(msSigners[sIdx]).revokeConfirmation(1);
          confirmations--;
          await expect(ms.connect(msSigners[0]).executeAction(1)).to.be.revertedWithCustomError(
            ms,
            "MultiSigGuardian__InsufficientConfirmations"
          );
          await ms.connect(msSigners[sIdx]).confirmAction(1);
          confirmations++;
        }
      }

      expect(confirmations).to.equal(threshold);
      await ms.connect(msSigners[0]).executeAction(1);
      expect(await ms.threshold()).to.equal(newThreshold);

      // Replay must fail
      await expect(ms.connect(msSigners[0]).executeAction(1)).to.be.revertedWithCustomError(
        ms,
        "MultiSigGuardian__AlreadyExecuted"
      );
    }
  });

  // =========================================================================
  // 6. COLLATERAL LENDING STATEFUL FUZZING (30 randomized loans: ETH/ERC20/Genesis NFT)
  // =========================================================================
  it("Fuzz 6: CollateralLending across 30 randomized ETH, ERC20, and ERC-4907 Genesis NFT loans", async function () {
    const [, admin, operator, executor, guardian, budgetManager, borrower, liquidator] =
      await ethers.getSigners();

    const { addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const loanToken = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "USDC",
      "USDC"
    )) as unknown as MockERC20;
    const colToken = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "RWA",
      "RWA"
    )) as unknown as MockERC20;
    const genesisNft = (await (await ethers.getContractFactory("MockERC4907")).deploy(
      "Genesis",
      "GEN"
    )) as unknown as MockERC4907;

    const lending = (await (
      await ethers.getContractFactory("CollateralLending")
    ).deploy(
      await loanToken.getAddress(),
      addresses.roleManager,
      addresses.emergencyPause,
      addresses.vault,
      addresses.timelock
    )) as unknown as CollateralLending;
    const lendingAddr = await lending.getAddress();

    // Fund pool generously
    const poolSeed = ethers.parseEther("500000");
    await loanToken.mint(admin.address, poolSeed);
    await loanToken.connect(admin).approve(lendingAddr, poolSeed);
    await lending.connect(admin).fundPool(poolSeed);

    await lending.connect(budgetManager).configureCollateral(ethers.ZeroAddress, {
      collateralType: 1,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("1000"),
      interestBps: 500,
      lateFeeBps: 200,
      gracePeriod: 3 * DAY,
    });
    await lending.connect(budgetManager).configureCollateral(await colToken.getAddress(), {
      collateralType: 2,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("1"),
      interestBps: 500,
      lateFeeBps: 200,
      gracePeriod: 3 * DAY,
    });
    await lending.connect(budgetManager).configureCollateral(await genesisNft.getAddress(), {
      collateralType: 3,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("500"),
      interestBps: 600,
      lateFeeBps: 200,
      gracePeriod: 3 * DAY,
    });

    // Fund borrower & liquidator for repayments/liquidations
    await loanToken.mint(borrower.address, ethers.parseEther("500000"));
    await loanToken.connect(borrower).approve(lendingAddr, ethers.MaxUint256);
    await loanToken.mint(liquidator.address, ethers.parseEther("500000"));
    await loanToken.connect(liquidator).approve(lendingAddr, ethers.MaxUint256);

    const nextRand = createPrng(6006);
    let nftCounter = 1;

    for (let loanId = 1; loanId <= 30; loanId++) {
      const kind = loanId % 3; // 0: ETH, 1: ERC20, 2: Genesis ERC-4907 NFT
      const installments = randRange(nextRand, 1, 6);
      const interval = randRange(nextRand, 7, 30) * DAY;
      let currentNftId = 0;

      if (kind === 0) {
        const ethCol = BigInt(randRange(nextRand, 1, 3)) * ethers.parseEther("0.5");
        const maxPrincipal = (ethCol * ethers.parseEther("1000")) / ethers.parseEther("1");
        const principal = (maxPrincipal * BigInt(randRange(nextRand, 20, 100))) / 100n;
        await lending.connect(borrower).borrowWithETH(principal, installments, interval, { value: ethCol });
      } else if (kind === 1) {
        const tokCol = BigInt(randRange(nextRand, 100, 1000)) * ethers.parseEther("1");
        const principal = (tokCol * BigInt(randRange(nextRand, 20, 100))) / 100n;
        await colToken.mint(borrower.address, tokCol);
        await colToken.connect(borrower).approve(lendingAddr, tokCol);
        await lending
          .connect(borrower)
          .borrowWithERC20(await colToken.getAddress(), tokCol, principal, installments, interval);
      } else {
        currentNftId = nftCounter++;
        const principal = BigInt(randRange(nextRand, 50, 500)) * ethers.parseEther("1");
        await genesisNft.mint(borrower.address, currentNftId);
        await genesisNft.connect(borrower).approve(lendingAddr, currentNftId);
        await lending
          .connect(borrower)
          .borrowWithGenesisNFT(await genesisNft.getAddress(), currentNftId, principal, installments, interval);
        // Utility preserved immediately on borrow
        expect(await genesisNft.userOf(currentNftId)).to.equal(borrower.address);
      }

      const outcome = nextRand() % 4;
      if (outcome === 0) {
        // Early full repayment in 1 tx
        await lending.connect(borrower).repayFull(loanId);
        expect((await lending.loans(loanId)).status).to.equal(2); // Repaid
        if (kind === 2) expect(await genesisNft.ownerOf(currentNftId)).to.equal(borrower.address);
      } else if (outcome === 1) {
        // Pay all installments (some inside grace period with late fee)
        for (let k = 0; k < installments; k++) {
          if (nextRand() % 2 === 0) {
            await advanceTime(interval + DAY); // 1 day late, inside 3-day grace period
          }
          await lending.connect(borrower).repayInstallment(loanId);
        }
        expect((await lending.loans(loanId)).status).to.equal(2); // Repaid
        if (kind === 2) expect(await genesisNft.ownerOf(currentNftId)).to.equal(borrower.address);
      } else if (outcome === 2) {
        // Default -> Liquidator buyout
        await advanceTime(interval + 4 * DAY);
        expect(await lending.isDefaulted(loanId)).to.be.true;
        if (kind === 2) expect(await genesisNft.userOf(currentNftId)).to.equal(ethers.ZeroAddress);
        await lending.connect(liquidator).liquidate(loanId);
        expect((await lending.loans(loanId)).status).to.equal(3); // Liquidated
        if (kind === 2) expect(await genesisNft.ownerOf(currentNftId)).to.equal(liquidator.address);
      } else {
        // Default -> Seize to TreasuryVault
        await advanceTime(interval + 4 * DAY);
        expect(await lending.isDefaulted(loanId)).to.be.true;
        await lending.connect(operator).seizeToTreasury(loanId);
        expect((await lending.loans(loanId)).status).to.equal(3); // Liquidated
        if (kind === 2) expect(await genesisNft.ownerOf(currentNftId)).to.equal(addresses.vault);
      }
    }

    // Final custody invariant: ZERO collateral stranded in CollateralLending!
    expect(await ethers.provider.getBalance(lendingAddr)).to.equal(0n);
    expect(await lending.lockedERC20Collateral(await colToken.getAddress())).to.equal(0n);
    expect(await colToken.balanceOf(lendingAddr)).to.equal(0n);
    expect(await genesisNft.balanceOf(lendingAddr)).to.equal(0n);
  });
});