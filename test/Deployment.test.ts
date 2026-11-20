import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";

describe("ZeroVault Deployment & Post-Deployment Verification", function () {
  it("Should deploy, wire dependencies, lock one-time setters, and assign separated roles", async function () {
    const [, admin, operator, executor, guardian, budgetManager] = await ethers.getSigners();

    const deployment = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: 2 * 24 * 60 * 60,
      silent: true,
    });

    const { roleManager, emergencyPause, timelock, vault, treasury, addresses } = deployment;

    // Verify all addresses are non-zero and properly wired
    expect(addresses.roleManager).to.not.equal(ethers.ZeroAddress);
    expect(addresses.emergencyPause).to.not.equal(ethers.ZeroAddress);
    expect(addresses.timelock).to.not.equal(ethers.ZeroAddress);
    expect(addresses.vault).to.not.equal(ethers.ZeroAddress);
    expect(addresses.treasury).to.not.equal(ethers.ZeroAddress);

    expect(await vault.controller()).to.equal(addresses.treasury);
    expect(await treasury.vault()).to.equal(addresses.vault);
    expect(await treasury.timelock()).to.equal(addresses.timelock);
    expect(await treasury.emergencyPause()).to.equal(addresses.emergencyPause);
    expect(await timelock.allowedTargets(addresses.treasury)).to.be.true;

    // One-time wiring must be permanently locked
    await expect(
      vault.connect(admin).initializeController(operator.address)
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__ControllerAlreadySet");

    await expect(
      timelock.connect(admin).initializeTarget(operator.address)
    ).to.be.revertedWithCustomError(timelock, "Timelock__InitialTargetAlreadySet");

    // Verify role separation (deployer no longer admin after handoff)
    const [deployer] = await ethers.getSigners();
    expect(await roleManager.isAdmin(deployer.address)).to.be.false;
    expect(await roleManager.isAdmin(admin.address)).to.be.true;
    expect(await roleManager.isOperator(operator.address)).to.be.true;
    expect(await roleManager.isExecutor(executor.address)).to.be.true;
    expect(await roleManager.isGuardian(guardian.address)).to.be.true;
    expect(await roleManager.isBudgetManager(budgetManager.address)).to.be.true;
    expect(await emergencyPause.paused()).to.be.false;
  });

  it("Should fail loudly if invalid zero address or out-of-range delay is provided", async function () {
    await expect(
      deployZeroVault({ operator: ethers.ZeroAddress, silent: true })
    ).to.be.rejectedWith("Post-deployment validation failed");

    await expect(
      deployZeroVault({ initialDelay: 60, silent: true })
    ).to.be.revertedWithCustomError(
      await ethers.getContractFactory("Timelock"),
      "Timelock__InvalidDelay"
    );
  });
});