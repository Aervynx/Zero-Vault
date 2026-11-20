import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EmergencyPause,
  MockERC20,
  RoleManager,
  Timelock,
  Treasury,
  TreasuryVault,
} from "../typechain-types";

describe("Treasury Integration & End-to-End Workflow", function () {
  let roleManager: RoleManager;
  let emergencyPause: EmergencyPause;
  let timelock: Timelock;
  let vault: TreasuryVault;
  let treasury: Treasury;
  let token: MockERC20;

  let admin: any;
  let operator: any;
  let executor: any;
  let guardian: any;
  let depositor: any;
  let recipient: any;

  const INITIAL_DELAY = 2 * 24 * 60 * 60; // 2 days

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [admin, operator, executor, guardian, depositor, recipient] = await ethers.getSigners();

    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();

    await roleManager.connect(admin).grantRole(await roleManager.OPERATOR_ROLE(), operator.address);
    await roleManager.connect(admin).grantRole(await roleManager.EXECUTOR_ROLE(), executor.address);
    await roleManager.connect(admin).grantRole(await roleManager.GUARDIAN_ROLE(), guardian.address);

    const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
    emergencyPause = (await EmergencyPauseFactory.deploy(
      await roleManager.getAddress()
    )) as unknown as EmergencyPause;
    await emergencyPause.waitForDeployment();

    const TimelockFactory = await ethers.getContractFactory("Timelock");
    timelock = (await TimelockFactory.deploy(
      await roleManager.getAddress(),
      await emergencyPause.getAddress(),
      INITIAL_DELAY
    )) as unknown as Timelock;
    await timelock.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("TreasuryVault");
    vault = (await VaultFactory.deploy(
      await roleManager.getAddress(),
      await emergencyPause.getAddress()
    )) as unknown as TreasuryVault;
    await vault.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = (await TreasuryFactory.deploy(
      await vault.getAddress(),
      await roleManager.getAddress(),
      await emergencyPause.getAddress(),
      await timelock.getAddress()
    )) as unknown as Treasury;
    await treasury.waitForDeployment();

    // Deterministic one-time wiring (no circular dependency)
    await vault.connect(admin).initializeController(await treasury.getAddress());
    await timelock.connect(admin).initializeTarget(await treasury.getAddress());

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    token = (await MockERC20Factory.deploy("Mock USD", "mUSD")) as unknown as MockERC20;
    await token.waitForDeployment();
  });

  it("Should deploy and wire all 5 core contracts cleanly", async function () {
    expect(await vault.controller()).to.equal(await treasury.getAddress());
    expect(await timelock.allowedTargets(await treasury.getAddress())).to.be.true;
    expect(await treasury.timelock()).to.equal(await timelock.getAddress());
  });

  it("Should execute full ETH withdrawal lifecycle: Deposit -> Request -> Queue -> Wait -> Execute", async function () {
    const depositAmount = ethers.parseEther("5");
    const withdrawAmount = ethers.parseEther("2");

    await treasury.connect(depositor).deposit({ value: depositAmount });
    expect(await vault.getBalance()).to.equal(depositAmount);

    // 1. Operator requests withdrawal
    await treasury
      .connect(operator)
      .requestETHWithdrawal(recipient.address, withdrawAmount, "Audit Grant");

    // 2. Operator queues execution in Timelock
    const treasuryAddr = await treasury.getAddress();
    const signature = "executeWithdrawal(uint256)";
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
    const salt = ethers.id("eth-req-1");

    await timelock.connect(operator).queueTransaction(treasuryAddr, 0, signature, data, eta, salt);

    // 3. Premature execution fails
    await expect(
      timelock.connect(executor).executeTransaction(treasuryAddr, 0, signature, data, eta, salt)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TxNotReady");

    // 4. Advance past delay, test Pause protection
    await advanceTime(INITIAL_DELAY + 120);
    await emergencyPause.connect(guardian).pause();

    await expect(
      timelock.connect(executor).executeTransaction(treasuryAddr, 0, signature, data, eta, salt)
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");

    // 5. Unpause and execute via Executor
    await emergencyPause.connect(admin).unpause();
    const balanceBefore = await ethers.provider.getBalance(recipient.address);

    await expect(
      timelock.connect(executor).executeTransaction(treasuryAddr, 0, signature, data, eta, salt)
    ).to.emit(treasury, "WithdrawalExecuted");

    const balanceAfter = await ethers.provider.getBalance(recipient.address);
    expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
    expect(await vault.getBalance()).to.equal(depositAmount - withdrawAmount);
  });

  it("Should execute full ERC20 withdrawal lifecycle through Timelock", async function () {
    const amount = ethers.parseEther("500");
    await token.mint(depositor.address, amount);
    await token.connect(depositor).approve(await treasury.getAddress(), amount);
    await treasury.connect(depositor).depositERC20(await token.getAddress(), amount);

    await treasury
      .connect(operator)
      .requestERC20Withdrawal(await token.getAddress(), recipient.address, amount, "Vendor");

    const treasuryAddr = await treasury.getAddress();
    const signature = "executeWithdrawal(uint256)";
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1]);
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;
    const salt = ethers.id("erc20-req-1");

    await timelock.connect(operator).queueTransaction(treasuryAddr, 0, signature, data, eta, salt);
    await advanceTime(INITIAL_DELAY + 120);

    await timelock.connect(executor).executeTransaction(treasuryAddr, 0, signature, data, eta, salt);

    expect(await token.balanceOf(recipient.address)).to.equal(amount);
    expect(await vault.getERC20Balance(await token.getAddress())).to.equal(0);
  });
});