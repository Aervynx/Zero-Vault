import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { BudgetController } from "../typechain-types";

describe("BudgetController (Rolling Epoch Spending Limits)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60; // 2 days
  const EPOCH_DURATION = 7 * 24 * 60 * 60; // 7 days

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  it("Should block split-drain withdrawals exceeding epoch cap and auto-reset on next epoch", async function () {
    const [, admin, operator, executor, guardian, budgetManager, depositor, recipient] =
      await ethers.getSigners();

    const { timelock, treasury, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const BudgetFactory = await ethers.getContractFactory("BudgetController");
    const budget = (await BudgetFactory.deploy(
      addresses.roleManager
    )) as unknown as BudgetController;
    await budget.waitForDeployment();

    await budget.connect(admin).initializeTreasury(addresses.treasury);
    await treasury.connect(admin).setBudgetController(await budget.getAddress());

    // Configure 3 ETH cap per 7-day epoch for native ETH
    const epochCap = ethers.parseEther("3");
    await budget.connect(budgetManager).configureBudget(ethers.ZeroAddress, epochCap, EPOCH_DURATION);

    // Budget manager cannot disable cap (admin only)
    await expect(
      budget.connect(budgetManager).disableBudget(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(budget, "BudgetController__Unauthorized");

    // Fund vault with 10 ETH
    await treasury.connect(depositor).deposit({ value: ethers.parseEther("10") });

    // Queue two 2-ETH withdrawals in the same epoch (total 4 ETH > 3 ETH cap)
    const sig = "withdraw(address,uint256)";
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [recipient.address, ethers.parseEther("2")]
    );
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
    const salt1 = ethers.id("split-1");
    const salt2 = ethers.id("split-2");

    await timelock.connect(operator).queueTransaction(addresses.treasury, 0, sig, data, eta, salt1);
    await timelock.connect(operator).queueTransaction(addresses.treasury, 0, sig, data, eta, salt2);

    await advanceTime(INITIAL_DELAY + 120);

    // First 2 ETH succeeds -> remaining budget = 1 ETH
    await timelock.connect(executor).executeTransaction(addresses.treasury, 0, sig, data, eta, salt1);
    expect(await budget.remainingBudget(ethers.ZeroAddress)).to.equal(ethers.parseEther("1"));

    // Second 2 ETH fails because 2 + 2 = 4 > 3 ETH epoch cap!
    await expect(
      timelock.connect(executor).executeTransaction(addresses.treasury, 0, sig, data, eta, salt2)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TxExecutionFailed");

    // Advance into the next epoch -> budget auto-resets to full 3 ETH and second withdrawal succeeds!
    await advanceTime(EPOCH_DURATION);
    expect(await budget.remainingBudget(ethers.ZeroAddress)).to.equal(epochCap);

    await timelock.connect(executor).executeTransaction(addresses.treasury, 0, sig, data, eta, salt2);
    expect(await budget.remainingBudget(ethers.ZeroAddress)).to.equal(ethers.parseEther("1"));
  });
});