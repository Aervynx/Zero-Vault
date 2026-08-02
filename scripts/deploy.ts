import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const RoleManager = await ethers.getContractFactory("RoleManager");
  const roleManager = await RoleManager.deploy(deployer.address);
  await roleManager.waitForDeployment();
  const roleManagerAddress = await roleManager.getAddress();
  console.log("RoleManager:", roleManagerAddress);

  const minDelay = 86400;
  const Timelock = await ethers.getContractFactory("Timelock");
  const timelock = await Timelock.deploy(roleManagerAddress, minDelay);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("Timelock:", timelockAddress);

  const TreasuryVault = await ethers.getContractFactory("TreasuryVault");
  const treasuryVault = await TreasuryVault.deploy(deployer.address); 
  await treasuryVault.waitForDeployment();
  const treasuryVaultAddress = await treasuryVault.getAddress();
  console.log("TreasuryVault:", treasuryVaultAddress);

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(
    treasuryVaultAddress,
    roleManagerAddress,
    timelockAddress
  );
  await treasury.waitForDeployment();
  console.log("Treasury:", await treasury.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});