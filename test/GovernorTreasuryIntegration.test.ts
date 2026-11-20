import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EmergencyPause,
  RoleManager,
  RuneToken,
  Treasury,
  TreasuryVault,
  ZeroVaultGovernor,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Governor & Treasury End-to-End Integration", function () {
  let roleManager: RoleManager;
  let emergencyPause: EmergencyPause;
  let vault: TreasuryVault;
  let treasury: Treasury;
  let governor: ZeroVaultGovernor;
  let token: RuneToken;
  let timelockController: any;

  let admin: HardhatEthersSigner;
  let voter1: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  const MIN_DELAY = 86400; // 1 day
  const VOTING_DELAY = 1n;
  const VOTING_PERIOD = 50n;
  const PROPOSAL_THRESHOLD = 0n;
  const QUORUM_PERCENTAGE = 4n;

  async function proposeVoteAndQueue(
    target: string,
    calldata: string,
    description: string
  ): Promise<string> {
    const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));

    const tx = await governor.connect(voter1).propose([target], [0n], [calldata], description);
    const receipt = await tx.wait();

    const event = receipt?.logs.find((l: any) => {
      try {
        return governor.interface.parseLog(l)?.name === "ProposalCreated";
      } catch {
        return false;
      }
    });
    const proposalId = governor.interface.parseLog(event as any)?.args.proposalId;

    await time.advanceBlockTo((await ethers.provider.getBlockNumber()) + Number(VOTING_DELAY) + 1);
    await governor.connect(voter1).castVote(proposalId, 1); // Vote For

    const deadline = await governor.proposalDeadline(proposalId);
    await time.advanceBlockTo(Number(deadline) + 1);

    await governor.queue([target], [0n], [calldata], descriptionHash);
    await time.increase(MIN_DELAY + 10);

    return descriptionHash;
  }

  beforeEach(async function () {
    [admin, voter1, guardian, recipient] = await ethers.getSigners();

    // 1. Deploy RoleManager & EmergencyPause
    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();
    await roleManager.connect(admin).grantRole(await roleManager.GUARDIAN_ROLE(), guardian.address);

    const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
    emergencyPause = (await EmergencyPauseFactory.deploy(
      await roleManager.getAddress()
    )) as unknown as EmergencyPause;
    await emergencyPause.waitForDeployment();

    // 2. Deploy OpenZeppelin TimelockController for DAO Governance
    const TimelockFactory = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockFactory.deploy(
      MIN_DELAY,
      [],
      [ethers.ZeroAddress],
      admin.address
    );
    await timelockController.waitForDeployment();

    // 3. Deploy real TreasuryVault & Treasury wired to TimelockController
    const VaultFactory = await ethers.getContractFactory("TreasuryVault");
    vault = (await VaultFactory.deploy(
      await roleManager.getAddress(),
      await emergencyPause.getAddress()
    )) as unknown as TreasuryVault;
    await vault.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = (await TreasuryFactory.deploy(
      await vault.getAddress(),
      await roleManager.getAddress(),
      await emergencyPause.getAddress(),
      await timelockController.getAddress()
    )) as unknown as Treasury;
    await treasury.waitForDeployment();

    await vault.connect(admin).initializeController(await treasury.getAddress());

    // 4. Deploy RuneToken & ZeroVaultGovernor
    const TokenFactory = await ethers.getContractFactory("RuneToken");
    token = (await TokenFactory.deploy(admin.address)) as unknown as RuneToken;
    await token.waitForDeployment();

    const GovernorFactory = await ethers.getContractFactory("ZeroVaultGovernor");
    governor = (await GovernorFactory.deploy(
      await token.getAddress(),
      await timelockController.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_PERCENTAGE
    )) as unknown as ZeroVaultGovernor;
    await governor.waitForDeployment();

    // 5. Grant PROPOSER_ROLE strictly to Governor
    const PROPOSER_ROLE = await timelockController.PROPOSER_ROLE();
    await timelockController.connect(admin).grantRole(PROPOSER_ROLE, await governor.getAddress());

    // 6. Fund voter with voting power and delegate
    await token.connect(admin).mint(voter1.address, ethers.parseEther("100000"));
    await token.connect(voter1).delegate(voter1.address);
  });

  it("Should execute a DAO proposal to withdraw ETH from real Treasury and TreasuryVault", async function () {
    const depositAmount = ethers.parseEther("5");
    const withdrawAmount = ethers.parseEther("2");

    await treasury.connect(admin).deposit({ value: depositAmount });
    expect(await vault.getBalance()).to.equal(depositAmount);

    const target = await treasury.getAddress();
    const calldata = treasury.interface.encodeFunctionData("withdraw", [
      recipient.address,
      withdrawAmount,
    ]);
    const descriptionHash = await proposeVoteAndQueue(
      target,
      calldata,
      "DAO Proposal #1: Withdraw 2 ETH from ZeroVault Treasury"
    );

    const balanceBefore = await ethers.provider.getBalance(recipient.address);

    await expect(governor.execute([target], [0n], [calldata], descriptionHash))
      .to.emit(governor, "ProposalExecuted")
      .and.to.emit(treasury, "Withdrawn")
      .withArgs(recipient.address, withdrawAmount);

    const balanceAfter = await ethers.provider.getBalance(recipient.address);
    expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
    expect(await vault.getBalance()).to.equal(depositAmount - withdrawAmount);
  });

  it("Should block DAO ERC20 withdrawal while paused and succeed after admin unpause", async function () {
    const depositAmount = ethers.parseEther("1000");
    const withdrawAmount = ethers.parseEther("500");

    await token.connect(admin).mint(admin.address, depositAmount);
    await token.connect(admin).approve(await treasury.getAddress(), depositAmount);
    await treasury.connect(admin).depositERC20(await token.getAddress(), depositAmount);

    const target = await treasury.getAddress();
    const calldata = treasury.interface.encodeFunctionData("withdrawERC20", [
      await token.getAddress(),
      recipient.address,
      withdrawAmount,
    ]);
    const descriptionHash = await proposeVoteAndQueue(
      target,
      calldata,
      "DAO Proposal #2: Withdraw 500 RUNE from ZeroVault Treasury"
    );

    // Guardian pauses protocol before DAO execution
    await emergencyPause.connect(guardian).pause();
    await expect(governor.execute([target], [0n], [calldata], descriptionHash)).to.be.reverted;

    // Admin unpauses -> DAO execution succeeds
    await emergencyPause.connect(admin).unpause();
    await expect(governor.execute([target], [0n], [calldata], descriptionHash))
      .to.emit(treasury, "ERC20Withdrawn")
      .withArgs(await token.getAddress(), recipient.address, withdrawAmount);

    expect(await token.balanceOf(recipient.address)).to.equal(withdrawAmount);
  });
});