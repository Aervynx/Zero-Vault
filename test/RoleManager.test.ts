import { expect } from "chai";
import { ethers } from "hardhat";
import { RoleManager } from "../typechain-types";

describe("RoleManager Contract", function () {
  let roleManager: RoleManager;
  let admin: any;
  let secondAdmin: any;
  let guardian: any;
  let operator: any;
  let executor: any;
  let budgetManager: any;
  let unauthorized: any;

  beforeEach(async function () {
    [admin, secondAdmin, guardian, operator, executor, budgetManager, unauthorized] =
      await ethers.getSigners();

    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();
  });

  it("Should revert deployment if initial admin is zero address", async function () {
    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    await expect(RoleManagerFactory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      RoleManagerFactory,
      "RoleManager__InvalidInitialization"
    );
  });

  it("Should set the correct deployer as default admin", async function () {
    const DEFAULT_ADMIN_ROLE = await roleManager.DEFAULT_ADMIN_ROLE();
    expect(await roleManager.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    expect(await roleManager.isAdmin(admin.address)).to.be.true;
    expect(await roleManager.getRoleMemberCount(DEFAULT_ADMIN_ROLE)).to.equal(1);
  });

  it("Should allow admin to grant and revoke all protocol roles", async function () {
    const GUARDIAN_ROLE = await roleManager.GUARDIAN_ROLE();
    const OPERATOR_ROLE = await roleManager.OPERATOR_ROLE();
    const EXECUTOR_ROLE = await roleManager.EXECUTOR_ROLE();
    const BUDGET_MANAGER_ROLE = await roleManager.BUDGET_MANAGER_ROLE();

    await expect(roleManager.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address))
      .to.emit(roleManager, "RoleGranted")
      .withArgs(GUARDIAN_ROLE, guardian.address, admin.address);

    await roleManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    await roleManager.connect(admin).grantRole(EXECUTOR_ROLE, executor.address);
    await roleManager.connect(admin).grantRole(BUDGET_MANAGER_ROLE, budgetManager.address);

    expect(await roleManager.isGuardian(guardian.address)).to.be.true;
    expect(await roleManager.isOperator(operator.address)).to.be.true;
    expect(await roleManager.isExecutor(executor.address)).to.be.true;
    expect(await roleManager.isBudgetManager(budgetManager.address)).to.be.true;

    await expect(roleManager.connect(admin).revokeRole(OPERATOR_ROLE, operator.address))
      .to.emit(roleManager, "RoleRevoked")
      .withArgs(OPERATOR_ROLE, operator.address, admin.address);

    expect(await roleManager.isOperator(operator.address)).to.be.false;
  });

  it("Should revert when granting any role to zero address", async function () {
    const OPERATOR_ROLE = await roleManager.OPERATOR_ROLE();
    await expect(
      roleManager.connect(admin).grantRole(OPERATOR_ROLE, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(roleManager, "RoleManager__ZeroAddress");
  });

  it("Should revert when non-admin or compromised operator tries to grant or revoke roles", async function () {
    const OPERATOR_ROLE = await roleManager.OPERATOR_ROLE();
    const GUARDIAN_ROLE = await roleManager.GUARDIAN_ROLE();
    const DEFAULT_ADMIN_ROLE = await roleManager.DEFAULT_ADMIN_ROLE();

    await roleManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

    await expect(
      roleManager.connect(unauthorized).grantRole(GUARDIAN_ROLE, unauthorized.address)
    ).to.be.revertedWithCustomError(roleManager, "AccessControlUnauthorizedAccount");

    await expect(
      roleManager.connect(operator).grantRole(DEFAULT_ADMIN_ROLE, operator.address)
    ).to.be.revertedWithCustomError(roleManager, "AccessControlUnauthorizedAccount");

    await expect(
      roleManager.connect(operator).revokeRole(DEFAULT_ADMIN_ROLE, admin.address)
    ).to.be.revertedWithCustomError(roleManager, "AccessControlUnauthorizedAccount");
  });

  it("Should prevent revoking or renouncing the last admin, but allow after adding a second admin", async function () {
    const DEFAULT_ADMIN_ROLE = await roleManager.DEFAULT_ADMIN_ROLE();

    await expect(
      roleManager.connect(admin).revokeRole(DEFAULT_ADMIN_ROLE, admin.address)
    ).to.be.revertedWithCustomError(roleManager, "RoleManager__CannotRemoveLastAdmin");

    await expect(
      roleManager.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address)
    ).to.be.revertedWithCustomError(roleManager, "RoleManager__CannotRemoveLastAdmin");

    // Adding a second admin unlocks safe rotation
    await roleManager.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, secondAdmin.address);
    expect(await roleManager.getRoleMemberCount(DEFAULT_ADMIN_ROLE)).to.equal(2);

    await roleManager.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address);
    expect(await roleManager.isAdmin(admin.address)).to.be.false;
    expect(await roleManager.isAdmin(secondAdmin.address)).to.be.true;
  });

  it("Should validate membership via checkRole", async function () {
    const EXECUTOR_ROLE = await roleManager.EXECUTOR_ROLE();
    await expect(
      roleManager.checkRole(EXECUTOR_ROLE, executor.address)
    ).to.be.revertedWithCustomError(roleManager, "RoleManager__MissingRole")
      .withArgs(executor.address, EXECUTOR_ROLE);

    await roleManager.connect(admin).grantRole(EXECUTOR_ROLE, executor.address);
    await expect(roleManager.checkRole(EXECUTOR_ROLE, executor.address)).to.not.be.reverted;
  });
});