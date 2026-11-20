import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { AssetRegistry, MockERC4907 } from "../typechain-types";

describe("ERC-4907 Rental Custody (Aervynx Aviation & Fleet Access NFTs)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60;
  const ERC721 = 3;

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  it("Should rent ERC-4907 NFT via Timelock while retaining Vault ownership, expire cleanly, and support guardian emergency revoke", async function () {
    const [, admin, operator, executor, guardian, budgetManager, depositor, renter] =
      await ethers.getSigners();

    const { emergencyPause, timelock, vault, treasury, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const RegistryFactory = await ethers.getContractFactory("AssetRegistry");
    const registry = (await RegistryFactory.deploy(
      addresses.roleManager,
      true
    )) as unknown as AssetRegistry;
    await registry.waitForDeployment();
    await vault.connect(admin).setAssetRegistry(await registry.getAddress());

    const TicketFactory = await ethers.getContractFactory("MockERC4907");
    const ticket = (await TicketFactory.deploy(
      "Aervynx Aviation Ticket",
      "AVT"
    )) as unknown as MockERC4907;
    await ticket.waitForDeployment();
    const ticketAddr = await ticket.getAddress();

    await registry.connect(budgetManager).registerAsset(ticketAddr, ERC721, 0);

    // Deposit Aviation Ticket NFT #101 into Vault
    await ticket.mint(depositor.address, 101);
    await ticket.connect(depositor).approve(addresses.treasury, 101);
    await treasury.connect(depositor).depositERC721(ticketAddr, 101);
    expect(await ticket.ownerOf(101)).to.equal(addresses.vault);

    // Operator cannot grant rental directly without Timelock
    const now = await currentTimestamp();
    const rentalExpiry = now + INITIAL_DELAY + 3600; // 1 hour after execution
    await expect(
      treasury.connect(operator).setERC4907User(ticketAddr, 101, renter.address, rentalExpiry)
    ).to.be.revertedWithCustomError(treasury, "Treasury__Unauthorized");

    // Queue rental through Timelock
    const sig = "setERC4907User(address,uint256,address,uint64)";
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address", "uint64"],
      [ticketAddr, 101, renter.address, rentalExpiry]
    );
    const eta = now + INITIAL_DELAY + 60;
    const salt = ethers.id("rent-101");

    await timelock.connect(operator).queueTransaction(addresses.treasury, 0, sig, data, eta, salt);
    await advanceTime(INITIAL_DELAY + 120);

    await expect(
      timelock.connect(executor).executeTransaction(addresses.treasury, 0, sig, data, eta, salt)
    )
      .to.emit(treasury, "ERC4907UserSet")
      .withArgs(ticketAddr, 101, renter.address, rentalExpiry);

    // Vault STILL owns the NFT while renter has temporary user rights
    expect(await ticket.ownerOf(101)).to.equal(addresses.vault);
    expect(await ticket.userOf(101)).to.equal(renter.address);

    // Guardian can emergency-revoke renter even while protocol is paused!
    await emergencyPause.connect(guardian).pause();
    await expect(treasury.connect(guardian).revokeERC4907User(ticketAddr, 101))
      .to.emit(treasury, "ERC4907UserRevoked")
      .withArgs(ticketAddr, 101, guardian.address);

    expect(await ticket.userOf(101)).to.equal(ethers.ZeroAddress);
    expect(await ticket.ownerOf(101)).to.equal(addresses.vault);
  });
});