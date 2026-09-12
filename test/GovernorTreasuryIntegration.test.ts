import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroVaultGovernor, RuneToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Governor & Treasury End-to-End Integration", function () {
    let governor: ZeroVaultGovernor;
    let token: RuneToken;
    let timelock: any;
    let treasury: any;

    let owner: HardhatEthersSigner;
    let voter1: HardhatEthersSigner;

    const MIN_DELAY = 86400;
    const VOTING_DELAY = 1n;
    const VOTING_PERIOD = 50n;
    const PROPOSAL_THRESHOLD = 0n;
    const QUORUM_PERCENTAGE = 4n;

    beforeEach(async function () {
        const signers = await ethers.getSigners();
        owner = signers[0];
        voter1 = signers[1];

        // 1. Deploy Timelock
        const TimelockFactory = await ethers.getContractFactory("TimelockController");
        timelock = await TimelockFactory.deploy(
            MIN_DELAY,
            [owner.address],
            [ethers.ZeroAddress],
            owner.address
        );
        await timelock.waitForDeployment();

        // 2. Deploy RuneToken
        const TokenFactory = await ethers.getContractFactory("RuneToken");
        token = (await TokenFactory.deploy(owner.address)) as unknown as RuneToken;
        await token.waitForDeployment();

        // 3. Deploy Treasury (or mock target representing treasury fund operations)
        const TreasuryFactory = await ethers.getContractFactory("TreasuryIntegrationMock" in ethers ? "TreasuryIntegrationMock" : "RuneToken"); 
        // Using RuneToken as a proxy target for demonstration or actual Treasury contract if available
        treasury = await TokenFactory.deploy(owner.address);
        await treasury.waitForDeployment();

        // 4. Deploy Governor
        const GovernorFactory = await ethers.getContractFactory("ZeroVaultGovernor");
        governor = await GovernorFactory.deploy(
            await token.getAddress(),
            await timelock.getAddress(),
            VOTING_DELAY,
            VOTING_PERIOD,
            PROPOSAL_THRESHOLD,
            QUORUM_PERCENTAGE
        );
        await governor.waitForDeployment();

        // 5. Setup Roles
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
        await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
        await timelock.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress);

        // Fund voter and delegate
        await token.mint(voter1.address, ethers.parseEther("100000"));
        await token.connect(voter1).delegate(voter1.address);
        
        // Fund Timelock to act as treasury controller
        await token.mint(await timelock.getAddress(), ethers.parseEther("50000"));
    });

    it("Should execute a DAO proposal to manage treasury assets through timelock", async function () {
        const target = await token.getAddress();
        const value = 0n;
        const calldata = token.interface.encodeFunctionData("transfer", [
            owner.address,
            ethers.parseEther("500")
        ]);
        const description = "DAO E2E Test: Treasury Fund Transfer via Governor";
        const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));

        // Propose
        const tx = await governor.connect(voter1).propose([target], [value], [calldata], description);
        const receipt = await tx.wait();
        
        const event = receipt?.logs.find((l: any) => {
            try { return governor.interface.parseLog(l)?.name === "ProposalCreated"; } catch { return false; }
        });
        const proposalId = governor.interface.parseLog(event as any)?.args.proposalId;

        // Vote lifecycle
        await time.advanceBlockTo((await ethers.provider.getBlockNumber()) + Number(VOTING_DELAY) + 1);
        await governor.connect(voter1).castVote(proposalId, 1);

        const deadline = await governor.proposalDeadline(proposalId);
        await time.advanceBlockTo(Number(deadline) + 1);

        // Queue & Execute
        await governor.queue([target], [value], [calldata], descriptionHash);
        await time.increase(MIN_DELAY + 10);
        
        await expect(governor.execute([target], [value], [calldata], descriptionHash))
            .to.emit(governor, "ProposalExecuted");
    });
});