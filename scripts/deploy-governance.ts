import { ethers } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying governance contracts with account:", deployer.address);

    const MIN_DELAY = 86400; // 1 day
    const VOTING_DELAY = 1n; // 1 block
    const VOTING_PERIOD = 50n; // ~10 minutes
    const PROPOSAL_THRESHOLD = 0n;
    const QUORUM_PERCENTAGE = 4n; // 4%

    // 1. Deploy TimelockController
    const TimelockFactory = await ethers.getContractFactory("TimelockController");
    const timelock = await TimelockFactory.deploy(
        MIN_DELAY,
        [deployer.address],
        [ethers.ZeroAddress],
        deployer.address
    );
    await timelock.waitForDeployment();
    console.log("TimelockController deployed to:", await timelock.getAddress());

    // 2. Deploy RuneToken
    const TokenFactory = await ethers.getContractFactory("RuneToken");
    const token = await TokenFactory.deploy(deployer.address);
    await token.waitForDeployment();
    console.log("RuneToken deployed to:", await token.getAddress());

    // 3. Deploy ZeroVaultGovernor
    const GovernorFactory = await ethers.getContractFactory("ZeroVaultGovernor");
    const governor = await GovernorFactory.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        VOTING_DELAY,
        VOTING_PERIOD,
        PROPOSAL_THRESHOLD,
        QUORUM_PERCENTAGE
    );
    await governor.waitForDeployment();
    console.log("ZeroVaultGovernor deployed to:", await governor.getAddress());

    // 4. Setup Timelock Roles
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();

    await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
    await timelock.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress);
    await timelock.grantRole(CANCELLER_ROLE, deployer.address);
    console.log("Timelock roles configured successfully.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});