import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  const RoleManager = await ethers.getContractFactory("RoleManager");
  const roleManager = await RoleManager.deploy(deployer.address);
  await roleManager.waitForDeployment();
  console.log("RoleManager deployed to:", await roleManager.getAddress());

  // Timelock requires roleManager address and initial delay (e.g., 2 days = 172800 seconds)
  const INITIAL_DELAY = 2 * 24 * 60 * 60; 
  const Timelock = await ethers.getContractFactory("Timelock");
  const timelock = await Timelock.deploy(await roleManager.getAddress(), INITIAL_DELAY);
  await timelock.waitForDeployment();
  console.log("Timelock deployed to:", await timelock.getAddress());

  const TreasuryVault = await ethers.getContractFactory("TreasuryVault");
  const vault = await TreasuryVault.deploy(await timelock.getAddress());
  await vault.waitForDeployment();
  console.log("TreasuryVault deployed to:", await vault.getAddress());

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(
    await vault.getAddress(),
    await roleManager.getAddress(),
    await timelock.getAddress()
  );
  await treasury.waitForDeployment();
  console.log("Treasury deployed to:", await treasury.getAddress());

  const RuneToken = await ethers.getContractFactory("RuneToken");
  const runeToken = await RuneToken.deploy(deployer.address);
  await runeToken.waitForDeployment();
  console.log("RuneToken deployed to:", await runeToken.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});