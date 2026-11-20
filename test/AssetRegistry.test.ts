import { expect } from "chai";
import { ethers } from "hardhat";
import {
  AssetRegistry,
  MockERC1155,
  MockERC20,
  MockERC721,
  RoleManager,
} from "../typechain-types";

describe("AssetRegistry Security Gatekeeper", function () {
  let roleManager: RoleManager;
  let registry: AssetRegistry;
  let erc20: MockERC20;
  let rwaToken: MockERC20;
  let nft: MockERC721;
  let hierarchicalNft: MockERC721;
  let multiToken: MockERC1155;

  let admin: any;
  let budgetManager: any;
  let guardian: any;
  let unauthorized: any;

  // AssetType enum values
  const ERC20 = 1;
  const RWA_ERC20 = 2;
  const ERC721 = 3;
  const HIERARCHICAL_NFT = 4;
  const ERC1155 = 5;

  beforeEach(async function () {
    [admin, budgetManager, guardian, unauthorized] = await ethers.getSigners();

    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();

    await roleManager
      .connect(admin)
      .grantRole(await roleManager.BUDGET_MANAGER_ROLE(), budgetManager.address);
    await roleManager.connect(admin).grantRole(await roleManager.GUARDIAN_ROLE(), guardian.address);

    const RegistryFactory = await ethers.getContractFactory("AssetRegistry");
    registry = (await RegistryFactory.deploy(
      await roleManager.getAddress(),
      true
    )) as unknown as AssetRegistry;
    await registry.waitForDeployment();

    const ERC20Factory = await ethers.getContractFactory("MockERC20");
    erc20 = (await ERC20Factory.deploy("Mock USD", "mUSD")) as unknown as MockERC20;
    rwaToken = (await ERC20Factory.deploy("US Treasury Bill", "tBILL")) as unknown as MockERC20;

    const ERC721Factory = await ethers.getContractFactory("MockERC721");
    nft = (await ERC721Factory.deploy("ZeroVault Art", "ZVA")) as unknown as MockERC721;
    hierarchicalNft = (await ERC721Factory.deploy(
      "Nested Parent NFT",
      "hNFT"
    )) as unknown as MockERC721;

    const ERC1155Factory = await ethers.getContractFactory("MockERC1155");
    multiToken = (await ERC1155Factory.deploy()) as unknown as MockERC1155;
  });

  it("Should verify contract code and ERC-165 interfaces on registration", async function () {
    // Reject EOA (not a contract)
    await expect(
      registry.connect(budgetManager).registerAsset(unauthorized.address, ERC20, 0)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__NotAContract");

    // Reject registering an ERC20 as ERC721 or ERC1155 (ERC-165 check fails)
    await expect(
      registry.connect(budgetManager).registerAsset(await erc20.getAddress(), ERC721, 0)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__InvalidInterface");

    await expect(
      registry.connect(budgetManager).registerAsset(await erc20.getAddress(), ERC1155, 0)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__InvalidInterface");

    // Valid registrations across all 5 asset classes
    await registry.connect(budgetManager).registerAsset(await erc20.getAddress(), ERC20, 0);
    await registry
      .connect(budgetManager)
      .registerAsset(await rwaToken.getAddress(), RWA_ERC20, ethers.parseEther("1000"));
    await registry.connect(budgetManager).registerAsset(await nft.getAddress(), ERC721, 0);
    await registry
      .connect(budgetManager)
      .registerAsset(await hierarchicalNft.getAddress(), HIERARCHICAL_NFT, 0);
    await registry.connect(budgetManager).registerAsset(await multiToken.getAddress(), ERC1155, 50);

    // Lane matching: RWA_ERC20 matches ERC20 lane; HierarchicalNFT matches ERC721 lane
    await expect(registry.validateDeposit(await rwaToken.getAddress(), ERC20)).to.not.be.reverted;
    await expect(registry.validateDeposit(await hierarchicalNft.getAddress(), ERC721)).to.not.be
      .reverted;

    // Lane mismatch rejected
    await expect(
      registry.validateDeposit(await nft.getAddress(), ERC20)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__AssetTypeMismatch");
  });

  it("Should enforce withdrawal caps and per-asset guardian freeze/admin unfreeze", async function () {
    const rwaAddr = await rwaToken.getAddress();
    const cap = ethers.parseEther("500");

    await registry.connect(budgetManager).registerAsset(rwaAddr, RWA_ERC20, cap);

    // Within cap passes; above cap reverts
    await expect(registry.validateWithdrawal(rwaAddr, ERC20, cap)).to.not.be.reverted;
    await expect(
      registry.validateWithdrawal(rwaAddr, ERC20, cap + 1n)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__ExceedsWithdrawalCap");

    // Guardian freezes only this specific RWA asset
    await expect(registry.connect(guardian).freezeAsset(rwaAddr))
      .to.emit(registry, "AssetFrozen")
      .withArgs(rwaAddr, guardian.address);

    await expect(registry.validateDeposit(rwaAddr, ERC20)).to.be.revertedWithCustomError(
      registry,
      "AssetRegistry__AssetFrozen"
    );
    await expect(registry.validateWithdrawal(rwaAddr, ERC20, 100n)).to.be.revertedWithCustomError(
      registry,
      "AssetRegistry__AssetFrozen"
    );

    // Guardian cannot unfreeze; only Admin can
    await expect(registry.connect(guardian).unfreezeAsset(rwaAddr)).to.be.revertedWithCustomError(
      registry,
      "AssetRegistry__Unauthorized"
    );

    await expect(registry.connect(admin).unfreezeAsset(rwaAddr))
      .to.emit(registry, "AssetUnfrozen")
      .withArgs(rwaAddr, admin.address);

    await expect(registry.validateWithdrawal(rwaAddr, ERC20, 100n)).to.not.be.reverted;
  });

  it("Should reject unregistered assets when strict allowlist is enabled", async function () {
    await expect(
      registry.validateDeposit(await erc20.getAddress(), ERC20)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__AssetNotAllowed");

    await expect(
      registry.connect(unauthorized).registerAsset(await erc20.getAddress(), ERC20, 0)
    ).to.be.revertedWithCustomError(registry, "AssetRegistry__Unauthorized");
  });
});