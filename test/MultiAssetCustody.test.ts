import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { AssetRegistry, MockERC1155, MockERC20, MockERC721 } from "../typechain-types";

describe("Multi-Asset Custody (RWA, ERC721, Hierarchical NFT, ERC1155 + AssetRegistry)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60;
  const RWA_ERC20 = 2;
  const ERC721 = 3;
  const HIERARCHICAL_NFT = 4;
  const ERC1155 = 5;

  async function currentTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  it("Should enforce AssetRegistry vetting, caps, per-asset freeze, and Timelock withdrawals across RWA, NFTs, and ERC1155", async function () {
    const [, admin, operator, executor, guardian, budgetManager, depositor, recipient] =
      await ethers.getSigners();

    const { roleManager, emergencyPause, timelock, vault, treasury, addresses } =
      await deployZeroVault({
        admin: admin.address,
        operator: operator.address,
        executor: executor.address,
        guardian: guardian.address,
        budgetManager: budgetManager.address,
        initialDelay: INITIAL_DELAY,
        silent: true,
      });

    // Deploy strict AssetRegistry and bind to TreasuryVault
    const RegistryFactory = await ethers.getContractFactory("AssetRegistry");
    const registry = (await RegistryFactory.deploy(
      addresses.roleManager,
      true
    )) as unknown as AssetRegistry;
    await registry.waitForDeployment();
    await vault.connect(admin).setAssetRegistry(await registry.getAddress());

    // Deploy mock RWA, Hierarchical NFT, and ERC1155
    const rwa = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Tokenized T-Bill",
      "tBILL"
    )) as unknown as MockERC20;
    const hNft = (await (await ethers.getContractFactory("MockERC721")).deploy(
      "Hierarchical Parent NFT",
      "hNFT"
    )) as unknown as MockERC721;
    const multi = (await (await ethers.getContractFactory("MockERC1155")).deploy()) as unknown as MockERC1155;

    const rwaAddr = await rwa.getAddress();
    const hNftAddr = await hNft.getAddress();
    const multiAddr = await multi.getAddress();

    // 1. Unregistered assets are rejected even on direct safeTransferFrom to Vault
    await hNft.mint(depositor.address, 1);
    await expect(
      hNft.connect(depositor)["safeTransferFrom(address,address,uint256)"](
        depositor.address,
        addresses.vault,
        1
      )
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__AssetNotAllowed");

    // 2. BudgetManager registers and vets all 3 asset classes
    await registry.connect(budgetManager).registerAsset(rwaAddr, RWA_ERC20, ethers.parseEther("500"));
    await registry.connect(budgetManager).registerAsset(hNftAddr, HIERARCHICAL_NFT, 0);
    await registry.connect(budgetManager).registerAsset(multiAddr, ERC1155, 10);

    // 3. Deposit RWA, Hierarchical NFT, and ERC1155
    await rwa.mint(depositor.address, ethers.parseEther("1000"));
    await rwa.connect(depositor).approve(addresses.treasury, ethers.parseEther("1000"));
    await treasury.connect(depositor).depositERC20(rwaAddr, ethers.parseEther("1000"));

    await hNft.connect(depositor).approve(addresses.treasury, 1);
    await treasury.connect(depositor).depositERC721(hNftAddr, 1);
    expect(await hNft.ownerOf(1)).to.equal(addresses.vault);

    await multi.mint(depositor.address, 7, 20);
    await multi.connect(depositor).setApprovalForAll(addresses.treasury, true);
    await treasury.connect(depositor).depositERC1155(multiAddr, 7, 20);
    expect(await multi.balanceOf(addresses.vault, 7)).to.equal(20);

    // 4. RWA withdrawal above cap (500) must fail
    await expect(
      treasury
        .connect(operator)
        .requestERC20Withdrawal(rwaAddr, recipient.address, ethers.parseEther("600"), "Over cap")
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__ExceedsWithdrawalCap");

    // 5. Queue & execute Hierarchical NFT withdrawal via Timelock
    const nftData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256"],
      [hNftAddr, recipient.address, 1]
    );
    const nftEta = (await currentTimestamp()) + INITIAL_DELAY + 60;
    const nftSalt = ethers.id("hnft-1");

    await timelock
      .connect(operator)
      .queueTransaction(addresses.treasury, 0, "withdrawERC721(address,address,uint256)", nftData, nftEta, nftSalt);

    // Queue ERC1155 withdrawal (within cap = 10)
    const mData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "uint256"],
      [multiAddr, recipient.address, 7, 10]
    );
    const mSalt = ethers.id("erc1155-1");
    await timelock
      .connect(operator)
      .queueTransaction(
        addresses.treasury,
        0,
        "withdrawERC1155(address,address,uint256,uint256)",
        mData,
        nftEta,
        mSalt
      );

    await advanceTime(INITIAL_DELAY + 120);

    // Guardian freezes ONLY hNft -> hNft withdrawal fails, while ERC1155 still succeeds!
    await registry.connect(guardian).freezeAsset(hNftAddr);

    await expect(
      timelock
        .connect(executor)
        .executeTransaction(addresses.treasury, 0, "withdrawERC721(address,address,uint256)", nftData, nftEta, nftSalt)
    ).to.be.revertedWithCustomError(timelock, "Timelock__TxExecutionFailed");

    // ERC1155 is NOT frozen -> executes cleanly
    await timelock
      .connect(executor)
      .executeTransaction(
        addresses.treasury,
        0,
        "withdrawERC1155(address,address,uint256,uint256)",
        mData,
        nftEta,
        mSalt
      );
    expect(await multi.balanceOf(recipient.address, 7)).to.equal(10);

    // Admin unfreezes hNft -> hNft withdrawal executes cleanly
    await registry.connect(admin).unfreezeAsset(hNftAddr);
    await timelock
      .connect(executor)
      .executeTransaction(addresses.treasury, 0, "withdrawERC721(address,address,uint256)", nftData, nftEta, nftSalt);
    expect(await hNft.ownerOf(1)).to.equal(recipient.address);
  });
});