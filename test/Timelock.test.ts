import { expect } from "chai";
import { ethers } from "hardhat";
import { EmergencyPause, RoleManager, Timelock } from "../typechain-types";

describe("Timelock Contract", function () {
  let roleManager: RoleManager;
  let emergencyPause: EmergencyPause;
  let timelock: Timelock;
  let admin: any;
  let operator: any;
  let executor: any;
  let guardian: any;
  let unauthorized: any;

  const INITIAL_DELAY = 2 * 24 * 60 * 60; // 2 days
  const GRACE_PERIOD = 14 * 24 * 60 * 60; // 14 days
  const SALT = ethers.id("op-1");

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [admin, operator, executor, guardian, unauthorized] = await ethers.getSigners();

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
  });

  it("Should reject invalid constructor arguments", async function () {
    const TimelockFactory = await ethers.getContractFactory("Timelock");

    await expect(
      TimelockFactory.deploy(ethers.ZeroAddress, await emergencyPause.getAddress(), INITIAL_DELAY)
    ).to.be.revertedWithCustomError(TimelockFactory, "Timelock__ZeroAddress");

    await expect(
      TimelockFactory.deploy(await roleManager.getAddress(), ethers.ZeroAddress, INITIAL_DELAY)
    ).to.be.revertedWithCustomError(TimelockFactory, "Timelock__ZeroAddress");

    await expect(
      TimelockFactory.deploy(await roleManager.getAddress(), await emergencyPause.getAddress(), 100)
    ).to.be.revertedWithCustomError(TimelockFactory, "Timelock__InvalidDelay");
  });

  it("Should reject non-allowed targets and allow one-time target initialization", async function () {
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;

    await expect(
      timelock.connect(operator).queueTransaction(unauthorized.address, 0, "", "0x", eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TargetNotAllowed");

    await timelock.connect(admin).initializeTarget(unauthorized.address);
    expect(await timelock.allowedTargets(unauthorized.address)).to.be.true;

    await expect(
      timelock.connect(admin).initializeTarget(guardian.address)
    ).to.be.revertedWithCustomError(timelock, "Timelock__InitialTargetAlreadySet");
  });

  it("Should enforce full lifecycle: None -> Queued -> Ready -> Executed", async function () {
    const timelockAddr = await timelock.getAddress();
    const newDelay = 3 * 24 * 60 * 60;
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newDelay]);
    const signature = "setDelay(uint256)";
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;

    const opId = await timelock.computeOperationId(timelockAddr, 0, signature, data, eta, SALT);
    expect(await timelock.getOperationState(opId)).to.equal(0); // None

    // Queue by operator
    await expect(
      timelock.connect(operator).queueTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.emit(timelock, "OperationQueued");
    expect(await timelock.getOperationState(opId)).to.equal(1); // Queued

    // Premature execution must fail
    await expect(
      timelock.connect(executor).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TxNotReady");

    // Advance past eta
    await advanceTime(INITIAL_DELAY + 120);
    expect(await timelock.getOperationState(opId)).to.equal(2); // Ready

    // Operator cannot execute
    await expect(
      timelock.connect(operator).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__Unauthorized");

    // Executor executes successfully
    await expect(
      timelock.connect(executor).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.emit(timelock, "OperationExecuted");

    expect(await timelock.getOperationState(opId)).to.equal(3); // Executed
    expect(await timelock.delay()).to.equal(newDelay);

    // Duplicate execution / replay must fail
    await expect(
      timelock.connect(executor).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidState");

    // Re-queueing same opId must fail
    await expect(
      timelock.connect(operator).queueTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TxAlreadyQueued");
  });

  it("Should block queue/execute when paused, but still allow guardian cancellation", async function () {
    const timelockAddr = await timelock.getAddress();
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [3 * 24 * 60 * 60]);
    const signature = "setDelay(uint256)";
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;

    await timelock.connect(operator).queueTransaction(timelockAddr, 0, signature, data, eta, SALT);
    const opId = await timelock.computeOperationId(timelockAddr, 0, signature, data, eta, SALT);

    await advanceTime(INITIAL_DELAY + 120);

    // Guardian activates emergency pause
    await emergencyPause.connect(guardian).pause();

    // Queueing new op fails while paused
    const nextEta = (await currentTimestamp()) + INITIAL_DELAY + 60;
    await expect(
      timelock
        .connect(operator)
        .queueTransaction(timelockAddr, 0, signature, data, nextEta, ethers.id("op-2"))
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");

    // Executing ready op fails while paused
    await expect(
      timelock.connect(executor).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");

    // Operator cannot cancel
    await expect(
      timelock.connect(operator).cancelTransaction(opId)
    ).to.be.revertedWithCustomError(timelock, "Timelock__Unauthorized");

    // Guardian CAN cancel while paused
    await expect(timelock.connect(guardian).cancelTransaction(opId))
      .to.emit(timelock, "OperationCancelled")
      .withArgs(opId, guardian.address);

    expect(await timelock.getOperationState(opId)).to.equal(4); // Cancelled

    // Even after unpause, cancelled operation cannot execute
    await emergencyPause.connect(admin).unpause();
    await expect(
      timelock.connect(executor).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__InvalidState");
  });

  it("Should expire operations after grace period and prevent direct setDelay manipulation", async function () {
    const timelockAddr = await timelock.getAddress();
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [3 * 24 * 60 * 60]);
    const signature = "setDelay(uint256)";
    const eta = (await currentTimestamp()) + INITIAL_DELAY + 60;

    // Direct setDelay by admin must fail
    await expect(
      timelock.connect(admin).setDelay(3 * 24 * 60 * 60)
    ).to.be.revertedWithCustomError(timelock, "Timelock__Unauthorized");

    await timelock.connect(operator).queueTransaction(timelockAddr, 0, signature, data, eta, SALT);
    const opId = await timelock.computeOperationId(timelockAddr, 0, signature, data, eta, SALT);

    // Advance past eta + GRACE_PERIOD
    await advanceTime(INITIAL_DELAY + GRACE_PERIOD + 120);
    expect(await timelock.getOperationState(opId)).to.equal(5); // Expired

    await expect(
      timelock.connect(executor).executeTransaction(timelockAddr, 0, signature, data, eta, SALT)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TxExpired");
  });
});