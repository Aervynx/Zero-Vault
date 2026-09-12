import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroVaultGovernor, RuneToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ZeroVaultGovernor Comprehensive Workflow", function () {
    let governor: ZeroVaultGovernor;
    let token: RuneToken;
    let timelock: any;

    let owner: HardhatEthersSigner;
    let voter1: HardhatEthersSigner;
    let voter2: HardhatEthersSigner;

    const VOTING_DELAY = 1n;
    const VOTING_PERIOD = 50n;
    const PROPOSAL_THRESHOLD = 0n;
    const QUORUM_PERCENTAGE = 4n;
    const MIN_DELAY = 86400;

    // Setup test environment and deploy core governance dependencies
    beforeEach(async function () {
        const signers = await ethers.getSigners();
        owner = signers[0];
        voter1 = signers[1];
        voter2 = signers[2];

        // Deploy Timelock Controller
        const TimelockFactory = await ethers.getContractFactory("TimelockController");
        timelock = await TimelockFactory.deploy(
            MIN_DELAY,
            [owner.address],
            [ethers.ZeroAddress],
            owner.address
        );
        await timelock.waitForDeployment();

        // Deploy Rune Token
        const TokenFactory = await ethers.getContractFactory("RuneToken");
        token = (await TokenFactory.deploy(owner.address)) as unknown as RuneToken;
        await token.waitForDeployment();

        // Mint tokens for voters and timelock treasury
        await token.mint(voter1.address, ethers.parseEther("100000"));
        await token.mint(voter2.address, ethers.parseEther("50000"));
        await token.mint(await timelock.getAddress(), ethers.parseEther("10000"));

        // Delegate voting power
        await token.connect(voter1).delegate(voter1.address);
        await token.connect(voter2).delegate(voter2.address);
        await token.delegate(owner.address);

        // Deploy ZeroVault Governor
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

        // Configure timelock roles
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
        const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();

        await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
        await timelock.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress);
        await timelock.grantRole(CANCELLER_ROLE, owner.address);
    });

    // Verify deployment parameters and linking
    it("Should deploy governor and link dependencies correctly", async function () {
        expect(await governor.getAddress()).to.be.properAddress;
        expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
        expect(await governor.votingDelay()).to.equal(VOTING_DELAY);
    });

    // Test full governance proposal, voting, queue, and execution lifecycle
    it("Should create, vote, queue, and execute a proposal successfully", async function () {
        const target = await token.getAddress();
        const value = 0n;
        const transferCalldata = token.interface.encodeFunctionData("transfer", [
            voter2.address,
            ethers.parseEther("1000")
        ]);
        const description = "Proposal #1: Transfer tokens from treasury";
        const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));

        // Create proposal
        const proposeTx = await governor.connect(voter1).propose(
            [target],
            [value],
            [transferCalldata],
            description
        );
        const receipt = await proposeTx.wait();
        
        const proposalCreatedEvent = receipt?.logs.find((log: any) => {
            try {
                return governor.interface.parseLog(log)?.name === "ProposalCreated";
            } catch {
                return false;
            }
        });
        
        const parsedLog = governor.interface.parseLog(proposalCreatedEvent as any);
        const proposalId = parsedLog?.args.proposalId;

        expect(await governor.state(proposalId)).to.equal(0);

        // Advance time/blocks past voting delay to activate proposal
        await time.advanceBlockTo((await ethers.provider.getBlockNumber()) + Number(VOTING_DELAY) + 1);
        expect(await governor.state(proposalId)).to.equal(1);

        // Cast votes
        await governor.connect(voter1).castVote(proposalId, 1);
        await governor.connect(voter2).castVote(proposalId, 1);

        // Advance blocks past voting period
        const deadline = await governor.proposalDeadline(proposalId);
        await time.advanceBlockTo(Number(deadline) + 1);
        expect(await governor.state(proposalId)).to.equal(4);

        // Queue proposal into timelock
        await governor.queue(
            [target],
            [value],
            [transferCalldata],
            descriptionHash
        );
        expect(await governor.state(proposalId)).to.equal(5);

        // Increase time past timelock delay
        await time.increase(MIN_DELAY + 10);

        // Execute proposal
        await governor.execute(
            [target],
            [value],
            [transferCalldata],
            descriptionHash
        );
        expect(await governor.state(proposalId)).to.equal(7);
    });
});