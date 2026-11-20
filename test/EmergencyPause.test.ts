import { expect } from "chai";
import { ethers } from "hardhat";
import { EmergencyPause, RoleManager } from "../typechain-types";

describe("EmergencyPause Contract", function () {
  let roleManager: RoleManager;
  let emergencyPause: EmergencyPause;
  let admin: any;
  let guardian: any;
  let operator: any;
  let unauthorized: any;

  beforeEach(async function () {
    [admin, guardian, operator, unauthorized] = await ethers.getSigners();

    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();

    await roleManager.connect(admin).grantRole(await roleManager.GUARDIAN_ROLE(), guardian.address);
    await roleManager.connect(admin).grantRole(await roleManager.OPERATOR_ROLE(), operator.address);

    const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
    emergencyPause = (await EmergencyPauseFactory.deploy(
      await roleManager.getAddress()
    )) as unknown as EmergencyPause;
    await emergencyPause.waitForDeployment();
  });

  it("Should revert deployment if roleManager is zero address", async function () {
    const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
    await expect(
      EmergencyPauseFactory.deploy(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(EmergencyPauseFactory, "EmergencyPause__ZeroAddress");
  });

  it("Should allow guardian to pause and admin to unpause", async function () {
    expect(await emergencyPause.paused()).to.be.false;

    await expect(emergencyPause.connect(guardian).pause())
      .to.emit(emergencyPause, "Paused")
      .withArgs(guardian.address);

    expect(await emergencyPause.paused()).to.be.true;

    await expect(emergencyPause.connect(admin).unpause())
      .to.emit(emergencyPause, "Unpaused")
      .withArgs(admin.address);

    expect(await emergencyPause.paused()).to.be.false;
  });

  it("Should allow admin to pause directly in an emergency", async function () {
    await expect(emergencyPause.connect(admin).pause())
      .to.emit(emergencyPause, "Paused")
      .withArgs(admin.address);
    expect(await emergencyPause.paused()).to.be.true;
  });

  it("Should revert when non-guardian or compromised operator tries to pause", async function () {
    await expect(
      emergencyPause.connect(unauthorized).pause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__Unauthorized");

    await expect(
      emergencyPause.connect(operator).pause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__Unauthorized");
  });

  it("Should prevent guardian or unauthorized accounts from unpausing", async function () {
    await emergencyPause.connect(guardian).pause();

    await expect(
      emergencyPause.connect(guardian).unpause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__Unauthorized");

    await expect(
      emergencyPause.connect(operator).unpause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__Unauthorized");

    await expect(
      emergencyPause.connect(unauthorized).unpause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__Unauthorized");
  });

  it("Should prevent duplicate pause or unpause calls", async function () {
    await expect(
      emergencyPause.connect(admin).unpause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__ExpectedPause");

    await emergencyPause.connect(guardian).pause();

    await expect(
      emergencyPause.connect(guardian).pause()
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");
  });

  it("Should enforce pause checks via requireNotPaused and requirePaused", async function () {
    await expect(emergencyPause.requireNotPaused()).to.not.be.reverted;
    await expect(emergencyPause.requirePaused()).to.be.revertedWithCustomError(
      emergencyPause,
      "EmergencyPause__ExpectedPause"
    );

    await emergencyPause.connect(guardian).pause();

    await expect(emergencyPause.requireNotPaused()).to.be.revertedWithCustomError(
      emergencyPause,
      "EmergencyPause__EnforcedPause"
    );
    await expect(emergencyPause.requirePaused()).to.not.be.reverted;
  });
});