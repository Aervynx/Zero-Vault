import { ethers, network } from "hardhat";
import {
  EmergencyPause,
  RoleManager,
  RuneToken,
  Timelock,
  Treasury,
  TreasuryVault,
} from "../typechain-types";

export interface DeploymentConfig {
  admin?: string;
  operator?: string;
  executor?: string;
  guardian?: string;
  budgetManager?: string;
  initialDelay?: number;
  silent?: boolean;
}

export interface DeploymentResult {
  network: string;
  roleManager: RoleManager;
  emergencyPause: EmergencyPause;
  timelock: Timelock;
  vault: TreasuryVault;
  treasury: Treasury;
  runeToken: RuneToken;
  addresses: {
    roleManager: string;
    emergencyPause: string;
    timelock: string;
    vault: string;
    treasury: string;
    runeToken: string;
  };
  roles: {
    admin: string;
    operator: string;
    executor: string;
    guardian: string;
    budgetManager: string;
  };
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Post-deployment validation failed: ${message}`);
  }
}

export async function deployZeroVault(config: DeploymentConfig = {}): Promise<DeploymentResult> {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const admin = config.admin ?? process.env.ADMIN_ADDRESS ?? deployer.address;
  const operator = config.operator ?? process.env.OPERATOR_ADDRESS ?? (signers[1]?.address ?? deployer.address);
  const executor = config.executor ?? process.env.EXECUTOR_ADDRESS ?? (signers[2]?.address ?? deployer.address);
  const guardian = config.guardian ?? process.env.GUARDIAN_ADDRESS ?? (signers[3]?.address ?? deployer.address);
  const budgetManager =
    config.budgetManager ?? process.env.BUDGET_MANAGER_ADDRESS ?? (signers[4]?.address ?? deployer.address);
  const initialDelay = config.initialDelay ?? 2 * 24 * 60 * 60; // 2 days

  // Pre-deployment parameter checks
  for (const [label, addr] of Object.entries({ admin, operator, executor, guardian, budgetManager })) {
    assertCondition(ethers.isAddress(addr) && addr !== ethers.ZeroAddress, `Invalid ${label} address: ${addr}`);
  }

  const log = (...args: any[]) => {
    if (!config.silent) console.log(...args);
  };

  log(`Deploying ZeroVault on network "${network.name}" with deployer: ${deployer.address}`);

  // 1. Deploy RoleManager (deployer acts as bootstrap admin if different from final admin)
  const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
  const roleManager = (await RoleManagerFactory.deploy(deployer.address)) as unknown as RoleManager;
  await roleManager.waitForDeployment();
  const roleManagerAddr = await roleManager.getAddress();

  // 2. Deploy shared EmergencyPause
  const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
  const emergencyPause = (await EmergencyPauseFactory.deploy(roleManagerAddr)) as unknown as EmergencyPause;
  await emergencyPause.waitForDeployment();
  const emergencyPauseAddr = await emergencyPause.getAddress();

  // 3. Deploy Timelock
  const TimelockFactory = await ethers.getContractFactory("Timelock");
  const timelock = (await TimelockFactory.deploy(
    roleManagerAddr,
    emergencyPauseAddr,
    initialDelay
  )) as unknown as Timelock;
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();

  // 4. Deploy TreasuryVault (no circular dependency)
  const VaultFactory = await ethers.getContractFactory("TreasuryVault");
  const vault = (await VaultFactory.deploy(roleManagerAddr, emergencyPauseAddr)) as unknown as TreasuryVault;
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();

  // 5. Deploy Treasury
  const TreasuryFactory = await ethers.getContractFactory("Treasury");
  const treasury = (await TreasuryFactory.deploy(
    vaultAddr,
    roleManagerAddr,
    emergencyPauseAddr,
    timelockAddr
  )) as unknown as Treasury;
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();

  // 6. Deploy RuneToken
  const RuneTokenFactory = await ethers.getContractFactory("RuneToken");
  const runeToken = (await RuneTokenFactory.deploy(admin)) as unknown as RuneToken;
  await runeToken.waitForDeployment();
  const runeTokenAddr = await runeToken.getAddress();

  // 7. Wire one-time immutable links
  await (await vault.connect(deployer).initializeController(treasuryAddr)).wait();
  await (await timelock.connect(deployer).initializeTarget(treasuryAddr)).wait();

  // 8. Configure roles
  await (await roleManager.connect(deployer).grantRole(await roleManager.OPERATOR_ROLE(), operator)).wait();
  await (await roleManager.connect(deployer).grantRole(await roleManager.EXECUTOR_ROLE(), executor)).wait();
  await (await roleManager.connect(deployer).grantRole(await roleManager.GUARDIAN_ROLE(), guardian)).wait();
  await (
    await roleManager.connect(deployer).grantRole(await roleManager.BUDGET_MANAGER_ROLE(), budgetManager)
  ).wait();

  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    const DEFAULT_ADMIN_ROLE = await roleManager.DEFAULT_ADMIN_ROLE();
    await (await roleManager.connect(deployer).grantRole(DEFAULT_ADMIN_ROLE, admin)).wait();
    await (await roleManager.connect(deployer).renounceRole(DEFAULT_ADMIN_ROLE, deployer.address)).wait();
  }

  // 9. Strict Post-Deployment Verification (fail loudly on any mismatch)
  assertCondition(await emergencyPause.roleManager() === roleManagerAddr, "EmergencyPause roleManager mismatch");
  assertCondition(await emergencyPause.paused() === false, "EmergencyPause must start unpaused");

  assertCondition(await timelock.roleManager() === roleManagerAddr, "Timelock roleManager mismatch");
  assertCondition(await timelock.emergencyPause() === emergencyPauseAddr, "Timelock emergencyPause mismatch");
  assertCondition(Number(await timelock.delay()) === initialDelay, "Timelock delay mismatch");
  assertCondition(await timelock.initialTargetSet() === true, "Timelock initialTargetSet not locked");
  assertCondition(await timelock.allowedTargets(treasuryAddr) === true, "Treasury not allowed on Timelock");

  assertCondition(await vault.roleManager() === roleManagerAddr, "Vault roleManager mismatch");
  assertCondition(await vault.emergencyPause() === emergencyPauseAddr, "Vault emergencyPause mismatch");
  assertCondition(await vault.controllerInitialized() === true, "Vault controller not locked");
  assertCondition(await vault.controller() === treasuryAddr, "Vault controller is not Treasury");

  assertCondition(await treasury.vault() === vaultAddr, "Treasury vault mismatch");
  assertCondition(await treasury.roleManager() === roleManagerAddr, "Treasury roleManager mismatch");
  assertCondition(await treasury.emergencyPause() === emergencyPauseAddr, "Treasury emergencyPause mismatch");
  assertCondition(await treasury.timelock() === timelockAddr, "Treasury timelock mismatch");

  assertCondition(await roleManager.isAdmin(admin), "Admin role not assigned");
  assertCondition(await roleManager.isOperator(operator), "Operator role not assigned");
  assertCondition(await roleManager.isExecutor(executor), "Executor role not assigned");
  assertCondition(await roleManager.isGuardian(guardian), "Guardian role not assigned");
  assertCondition(await roleManager.isBudgetManager(budgetManager), "BudgetManager role not assigned");

  const addresses = {
    roleManager: roleManagerAddr,
    emergencyPause: emergencyPauseAddr,
    timelock: timelockAddr,
    vault: vaultAddr,
    treasury: treasuryAddr,
    runeToken: runeTokenAddr,
  };

  const roles = { admin, operator, executor, guardian, budgetManager };

  log("ZeroVault deployment and post-deployment checks succeeded:");
  log(JSON.stringify({ network: network.name, addresses, roles }, null, 2));

  return {
    network: network.name,
    roleManager,
    emergencyPause,
    timelock,
    vault,
    treasury,
    runeToken,
    addresses,
    roles,
  };
}

if (require.main === module) {
  deployZeroVault().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}