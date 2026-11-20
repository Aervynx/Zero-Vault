import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { MockERC20, MockFeeOnTransferToken, TreasuryVesting } from "../typechain-types";

describe("TreasuryVesting (TGE, Cliff, Linear & Quarterly Schedules)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60;
  const DAY = 24 * 60 * 60;

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  it("Should handle TGE unlock + linear vesting, pause protection, and fee-on-transfer rejection", async function () {
    const [, admin, operator, executor, guardian, budgetManager, beneficiary] =
      await ethers.getSigners();

    const { emergencyPause, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const VestingFactory = await ethers.getContractFactory("TreasuryVesting");
    const vesting = (await VestingFactory.deploy(
      addresses.roleManager,
      addresses.emergencyPause,
      addresses.timelock
    )) as unknown as TreasuryVesting;
    await vesting.waitForDeployment();
    const vestingAddr = await vesting.getAddress();

    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Ecosystem Token",
      "ECO"
    )) as unknown as MockERC20;
    const feeToken = (await (
      await ethers.getContractFactory("MockFeeOnTransferToken")
    ).deploy()) as unknown as MockFeeOnTransferToken;

    const total = ethers.parseEther("1000");
    const tge = ethers.parseEther("200"); // 20% at TGE
    const now = await currentTimestamp();

    // Reject fee-on-transfer token
    await feeToken.mint(admin.address, total);
    await feeToken.connect(admin).approve(vestingAddr, total);
    await expect(
      vesting.connect(admin).createSchedule({
        token: await feeToken.getAddress(),
        beneficiary: beneficiary.address,
        totalAmount: total,
        tgeAmount: tge,
        startTime: now,
        cliffDuration: 0,
        duration: 100 * DAY,
        slicePeriod: 1,
        revocable: false,
      })
    ).to.be.revertedWithCustomError(vesting, "TreasuryVesting__FeeOnTransferNotSupported");

    // Create 20% TGE + 100-day linear schedule
    await token.mint(admin.address, total);
    await token.connect(admin).approve(vestingAddr, total);
    await vesting.connect(admin).createSchedule({
      token: await token.getAddress(),
      beneficiary: beneficiary.address,
      totalAmount: total,
      tgeAmount: tge,
      startTime: now,
      cliffDuration: 0,
      duration: 100 * DAY,
      slicePeriod: 1,
      revocable: false,
    });

    // Pause blocks claim
    await emergencyPause.connect(guardian).pause();
    await expect(vesting.connect(beneficiary).claim(1)).to.be.revertedWithCustomError(
      emergencyPause,
      "EmergencyPause__EnforcedPause"
    );
    await emergencyPause.connect(admin).unpause();

    // Claim immediately at TGE (~200 tokens)
    await vesting.connect(beneficiary).claim(1);
    expect(await token.balanceOf(beneficiary.address)).to.be.gte(tge);

    // Advance past full duration -> claims exact 1000 total
    await advanceTime(101 * DAY);
    await vesting.connect(beneficiary).claim(1);
    expect(await token.balanceOf(beneficiary.address)).to.equal(total);
  });

  it("Should enforce cliff + quarterly stepping and Timelock-only revocation preserving vested share", async function () {
    const [, admin, operator, executor, guardian, budgetManager, teamMember] =
      await ethers.getSigners();

    const { addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    // Use admin as timelock stand-in for direct unit check of revokeSchedule gating
    const VestingFactory = await ethers.getContractFactory("TreasuryVesting");
    const vesting = (await VestingFactory.deploy(
      addresses.roleManager,
      addresses.emergencyPause,
      executor.address // executor acts as timelock in this unit test
    )) as unknown as TreasuryVesting;
    await vesting.waitForDeployment();
    const vestingAddr = await vesting.getAddress();

    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Team Token",
      "TEAM"
    )) as unknown as MockERC20;

    const total = ethers.parseEther("400");
    const now = await currentTimestamp();
    await token.mint(admin.address, total);
    await token.connect(admin).approve(vestingAddr, total);

    // 180-day cliff + 360-day duration with 90-day quarterly slices (4 quarters = 100 each)
    await vesting.connect(admin).createSchedule({
      token: await token.getAddress(),
      beneficiary: teamMember.address,
      totalAmount: total,
      tgeAmount: 0,
      startTime: now,
      cliffDuration: 180 * DAY,
      duration: 360 * DAY,
      slicePeriod: 90 * DAY,
      revocable: true,
    });

    // Before cliff: 0 claimable
    await advanceTime(100 * DAY);
    expect(await vesting.claimableAmount(1)).to.equal(0);

    // 180 days cliff + 89 days (still before first 90-day quarter): 0 claimable
    await advanceTime(169 * DAY);
    expect(await vesting.claimableAmount(1)).to.equal(0);

    // Cross first quarter (total 180 + 90 = 270 days): exactly 100 tokens vested!
    await advanceTime(2 * DAY);
    expect(await vesting.claimableAmount(1)).to.equal(ethers.parseEther("100"));

    // Non-timelock (admin) cannot revoke directly
    await expect(
      vesting.connect(admin).revokeSchedule(1, addresses.vault)
    ).to.be.revertedWithCustomError(vesting, "TreasuryVesting__Unauthorized");

    // Timelock revokes: 300 unvested refunded to TreasuryVault, 100 vested kept for teamMember!
    await expect(vesting.connect(executor).revokeSchedule(1, addresses.vault))
      .to.emit(vesting, "ScheduleRevoked")
      .withArgs(1, addresses.vault, ethers.parseEther("300"));

    expect(await token.balanceOf(addresses.vault)).to.equal(ethers.parseEther("300"));

    // Team member can still claim their 100 already-vested tokens!
    await vesting.connect(teamMember).claim(1);
    expect(await token.balanceOf(teamMember.address)).to.equal(ethers.parseEther("100"));
  });
});