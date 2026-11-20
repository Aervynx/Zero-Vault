import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { MockERC20, RevenueSplitter, RevertingReceiver } from "../typechain-types";

describe("RevenueSplitter (Pull-Payment ETH & ERC20 Fee Distribution)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60;

  it("Should split ETH and ERC20 with zero wei dust, isolate reverting recipients, and respect Pause", async function () {
    const [, admin, operator, executor, guardian, budgetManager, fleetPool, payer] =
      await ethers.getSigners();

    const { emergencyPause, vault, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    // Include a RevertingReceiver to prove Pull-Payment prevents DoS on other recipients
    const badReceiver = (await (
      await ethers.getContractFactory("RevertingReceiver")
    ).deploy()) as unknown as RevertingReceiver;
    await badReceiver.waitForDeployment();
    const badAddr = await badReceiver.getAddress();

    // 50% TreasuryVault, 30% FleetPool, 20% badReceiver
    const SplitterFactory = await ethers.getContractFactory("RevenueSplitter");
    const splitter = (await SplitterFactory.deploy(addresses.emergencyPause, addresses.timelock, [
      { recipient: addresses.vault, bps: 5000 },
      { recipient: fleetPool.address, bps: 3000 },
      { recipient: badAddr, bps: 2000 },
    ])) as unknown as RevenueSplitter;
    await splitter.waitForDeployment();
    const splitterAddr = await splitter.getAddress();

    // 1. Send odd wei amount (1 ETH + 1 wei) to verify zero dust loss
    const oddAmount = ethers.parseEther("1") + 1n;
    await payer.sendTransaction({ to: splitterAddr, value: oddAmount });
    await splitter.distributeETH();

    const vaultPending = await splitter.pendingETH(addresses.vault);
    const fleetPending = await splitter.pendingETH(fleetPool.address);
    const badPending = await splitter.pendingETH(badAddr);
    expect(vaultPending + fleetPending + badPending).to.equal(oddAmount);

    // Pause blocks claims
    await emergencyPause.connect(guardian).pause();
    await expect(splitter.claimETH(addresses.vault)).to.be.revertedWithCustomError(
      emergencyPause,
      "EmergencyPause__EnforcedPause"
    );
    await emergencyPause.connect(admin).unpause();

    // Bad receiver fails, but TreasuryVault & FleetPool still claim cleanly (zero DoS!)
    await expect(splitter.claimETH(badAddr)).to.be.revertedWithCustomError(
      splitter,
      "RevenueSplitter__TransferFailed"
    );

    await splitter.claimETH(addresses.vault);
    expect(await vault.getBalance()).to.equal(vaultPending);

    // 2. ERC20 distribution
    const token = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Fee USD",
      "fUSD"
    )) as unknown as MockERC20;
    const tokenAddr = await token.getAddress();
    const feeTotal = ethers.parseEther("1000");

    await token.mint(splitterAddr, feeTotal);
    await splitter.distributeERC20(tokenAddr);

    await splitter.claimERC20(tokenAddr, addresses.vault);
    await splitter.claimERC20(tokenAddr, fleetPool.address);

    expect(await vault.getERC20Balance(tokenAddr)).to.equal(ethers.parseEther("500"));
    expect(await token.balanceOf(fleetPool.address)).to.equal(ethers.parseEther("300"));
  });

  it("Should restrict updateSplits strictly to Timelock and reject invalid splits", async function () {
    const [, admin, operator, executor, guardian, budgetManager, fleetPool] =
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

    const SplitterFactory = await ethers.getContractFactory("RevenueSplitter");

    // Reject bps sum != 10000
    await expect(
      SplitterFactory.deploy(addresses.emergencyPause, executor.address, [
        { recipient: addresses.vault, bps: 6000 },
      ])
    ).to.be.revertedWithCustomError(SplitterFactory, "RevenueSplitter__InvalidSplits");

    // Reject duplicate recipients
    await expect(
      SplitterFactory.deploy(addresses.emergencyPause, executor.address, [
        { recipient: addresses.vault, bps: 5000 },
        { recipient: addresses.vault, bps: 5000 },
      ])
    ).to.be.revertedWithCustomError(SplitterFactory, "RevenueSplitter__DuplicateRecipient");

    const splitter = (await SplitterFactory.deploy(addresses.emergencyPause, executor.address, [
      { recipient: addresses.vault, bps: 5000 },
      { recipient: fleetPool.address, bps: 5000 },
    ])) as unknown as RevenueSplitter;
    await splitter.waitForDeployment();

    // Admin cannot bypass Timelock
    await expect(
      splitter.connect(admin).updateSplits([{ recipient: admin.address, bps: 10000 }])
    ).to.be.revertedWithCustomError(splitter, "RevenueSplitter__Unauthorized");

    // Timelock updates splits cleanly
    await expect(
      splitter.connect(executor).updateSplits([
        { recipient: addresses.vault, bps: 7000 },
        { recipient: fleetPool.address, bps: 3000 },
      ])
    ).to.emit(splitter, "SplitsUpdated");
  });
});