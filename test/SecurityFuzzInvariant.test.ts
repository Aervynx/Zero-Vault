import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { ReentrancyAttacker, RevertingReceiver } from "../typechain-types";

describe("ZeroVault Security: Reentrancy, Fuzz & Invariant Suite", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60; // 2 days

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // Simple deterministic PRNG for reproducible fuzzing
  function createPrng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s;
    };
  }

  describe("Reentrancy & Transfer-Failure Atomicity", function () {
    it("Should block reentrancy attempts even if the malicious receiver holds EXECUTOR_ROLE", async function () {
      const [, admin, operator, executor, guardian, budgetManager, depositor] =
        await ethers.getSigners();

      const { roleManager, timelock, vault, treasury, addresses } = await deployZeroVault({
        admin: admin.address,
        operator: operator.address,
        executor: executor.address,
        guardian: guardian.address,
        budgetManager: budgetManager.address,
        initialDelay: INITIAL_DELAY,
        silent: true,
      });

      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = (await AttackerFactory.deploy(
        addresses.treasury,
        addresses.vault,
        addresses.timelock
      )) as unknown as ReentrancyAttacker;
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // Worst-case assumption: attacker also has EXECUTOR_ROLE
      await roleManager.connect(admin).grantRole(await roleManager.EXECUTOR_ROLE(), attackerAddr);

      await treasury.connect(depositor).deposit({ value: ethers.parseEther("5") });

      const withdrawAmount = ethers.parseEther("1");
      await treasury.connect(operator).requestETHWithdrawal(attackerAddr, withdrawAmount, "Test");

      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
      const signature = "executeWithdrawal(uint256)";
      const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
      const salt = ethers.id("reentry-test");

      await timelock.connect(operator).queueTransaction(addresses.treasury, 0, signature, data, eta, salt);
      await advanceTime(INITIAL_DELAY + 120);

      await attacker.configureAttack(1, eta, salt);
      await timelock.connect(executor).executeTransaction(addresses.treasury, 0, signature, data, eta, salt);

      // Reentrancy was attempted once and both re-entry paths were blocked
      expect(await attacker.attackCount()).to.equal(1);
      expect(await attacker.timelockReentryBlocked()).to.be.true;
      expect(await attacker.treasuryReentryBlocked()).to.be.true;

      // Exact balance conserved (no double drain)
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(withdrawAmount);
      expect(await vault.getBalance()).to.equal(ethers.parseEther("4"));
    });

    it("Should atomically revert and preserve state when ETH recipient rejects transfer", async function () {
      const [, admin, operator, executor, guardian, budgetManager, depositor] =
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

      const ReceiverFactory = await ethers.getContractFactory("RevertingReceiver");
      const revertingReceiver = (await ReceiverFactory.deploy()) as unknown as RevertingReceiver;
      await revertingReceiver.waitForDeployment();

      await treasury.connect(depositor).deposit({ value: ethers.parseEther("3") });
      await treasury
        .connect(operator)
        .requestETHWithdrawal(await revertingReceiver.getAddress(), ethers.parseEther("1"), "Bad");

      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
      const signature = "executeWithdrawal(uint256)";
      const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
      const salt = ethers.id("revert-test");
      const opId = await timelock.computeOperationId(addresses.treasury, 0, signature, data, eta, salt);

      await timelock.connect(operator).queueTransaction(addresses.treasury, 0, signature, data, eta, salt);
      await advanceTime(INITIAL_DELAY + 120);

      await expect(
        timelock.connect(executor).executeTransaction(addresses.treasury, 0, signature, data, eta, salt)
      ).to.be.revertedWithCustomError(timelock, "Timelock__TxExecutionFailed");

      // State remains completely uncorrupted after failed transfer
      const req = await treasury.withdrawalRequests(1);
      expect(req.status).to.equal(1); // Still Pending
      expect(await timelock.getOperationState(opId)).to.equal(2); // Still Ready
      expect(await vault.getBalance()).to.equal(ethers.parseEther("3"));
    });
  });

  describe("Fuzz Testing (Delays, Amounts, Salts)", function () {
    it("Should fuzz-validate Timelock delay bounds across 25 randomized inputs", async function () {
      const [, admin] = await ethers.getSigners();
      const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
      const rm = await RoleManagerFactory.deploy(admin.address);
      const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
      const ep = await EmergencyPauseFactory.deploy(await rm.getAddress());
      const TimelockFactory = await ethers.getContractFactory("Timelock");

      const MIN_DELAY = 86400;
      const MAX_DELAY = 30 * 86400;
      const nextRand = createPrng(42);

      for (let i = 0; i < 25; i++) {
        const candidateDelay = nextRand() % (45 * 86400);
        if (candidateDelay < MIN_DELAY || candidateDelay > MAX_DELAY) {
          await expect(
            TimelockFactory.deploy(await rm.getAddress(), await ep.getAddress(), candidateDelay)
          ).to.be.revertedWithCustomError(TimelockFactory, "Timelock__InvalidDelay");
        } else {
          const tl = await TimelockFactory.deploy(
            await rm.getAddress(),
            await ep.getAddress(),
            candidateDelay
          );
          expect(await tl.delay()).to.equal(candidateDelay);
        }
      }
    });
  });

  describe("Protocol Invariants (Multi-Step Randomized Sequences)", function () {
    it("Should preserve custody, authorization, pause, and single-execution invariants across randomized operations", async function () {
      const [, admin, operator, executor, guardian, budgetManager, depositor, recipient, attacker] =
        await ethers.getSigners();

      const { emergencyPause, timelock, vault, treasury, addresses } = await deployZeroVault({
        admin: admin.address,
        operator: operator.address,
        executor: executor.address,
        guardian: guardian.address,
        budgetManager: budgetManager.address,
        initialDelay: INITIAL_DELAY,
        silent: true,
      });

      const nextRand = createPrng(1337);
      let totalDeposited = 0n;
      let totalWithdrawn = 0n;
      let reqCounter = 0;

      for (let step = 0; step < 10; step++) {
        // 1. Random ETH deposit between 0.1 and 1.0 ETH
        const depWei = BigInt((nextRand() % 10) + 1) * ethers.parseEther("0.1");
        await treasury.connect(depositor).deposit({ value: depWei });
        totalDeposited += depWei;

        // Invariant 1: Treasury holds 0 ETH; Vault holds exact net balance
        expect(await ethers.provider.getBalance(addresses.treasury)).to.equal(0n);
        expect(await vault.getBalance()).to.equal(totalDeposited - totalWithdrawn);

        // Invariant 2: Unauthorized caller can never drain vault
        await expect(
          vault.connect(attacker).transferETH(attacker.address, depWei)
        ).to.be.revertedWithCustomError(vault, "TreasuryVault__Unauthorized");

        // 2. Request & queue a random partial withdrawal
        const currentBal = totalDeposited - totalWithdrawn;
        const withdrawWei = (currentBal * BigInt((nextRand() % 4) + 1)) / 10n;
        reqCounter++;

        await treasury
          .connect(operator)
          .requestETHWithdrawal(recipient.address, withdrawWei, `Step ${step}`);

        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [reqCounter]);
        const signature = "executeWithdrawal(uint256)";
        const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
        const salt = ethers.id(`inv-step-${step}`);
        const opId = await timelock.computeOperationId(
          addresses.treasury,
          0,
          signature,
          data,
          eta,
          salt
        );

        await timelock
          .connect(operator)
          .queueTransaction(addresses.treasury, 0, signature, data, eta, salt);

        // Invariant 3: Premature execution always reverts
        await expect(
          timelock
            .connect(executor)
            .executeTransaction(addresses.treasury, 0, signature, data, eta, salt)
        ).to.be.revertedWithCustomError(timelock, "Timelock__TxNotReady");

        await advanceTime(INITIAL_DELAY + 120);

        const shouldCancel = nextRand() % 3 === 0;
        if (shouldCancel) {
          // Pause -> cancel -> unpause -> verify cancelled op cannot execute
          await emergencyPause.connect(guardian).pause();
          await expect(
            timelock
              .connect(executor)
              .executeTransaction(addresses.treasury, 0, signature, data, eta, salt)
          ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");

          await timelock.connect(guardian).cancelTransaction(opId);
          await emergencyPause.connect(admin).unpause();

          await expect(
            timelock
              .connect(executor)
              .executeTransaction(addresses.treasury, 0, signature, data, eta, salt)
          ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidState");
        } else {
          // Execute once, then prove replay is impossible (Invariant 4)
          await timelock
            .connect(executor)
            .executeTransaction(addresses.treasury, 0, signature, data, eta, salt);
          totalWithdrawn += withdrawWei;

          await expect(
            timelock
              .connect(executor)
              .executeTransaction(addresses.treasury, 0, signature, data, eta, salt)
          ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidState");
        }

        // Re-verify custody conservation invariant after every step
        expect(await ethers.provider.getBalance(addresses.treasury)).to.equal(0n);
        expect(await vault.getBalance()).to.equal(totalDeposited - totalWithdrawn);
      }
    });
  });
});