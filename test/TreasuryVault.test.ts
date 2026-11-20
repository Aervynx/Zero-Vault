import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EmergencyPause,
  MockERC20,
  MockFeeOnTransferToken,
  RoleManager,
  TreasuryVault,
} from "../typechain-types";

describe("TreasuryVault Contract", function () {
  let roleManager: RoleManager;
  let emergencyPause: EmergencyPause;
  let vault: TreasuryVault;
  let token: MockERC20;
  let feeToken: MockFeeOnTransferToken;
  let admin: any;
  let controller: any;
  let guardian: any;
  let user: any;
  let recipient: any;

  beforeEach(async function () {
    [admin, controller, guardian, user, recipient] = await ethers.getSigners();

    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();
    await roleManager.connect(admin).grantRole(await roleManager.GUARDIAN_ROLE(), guardian.address);

    const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPause");
    emergencyPause = (await EmergencyPauseFactory.deploy(
      await roleManager.getAddress()
    )) as unknown as EmergencyPause;
    await emergencyPause.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("TreasuryVault");
    vault = (await VaultFactory.deploy(
      await roleManager.getAddress(),
      await emergencyPause.getAddress()
    )) as unknown as TreasuryVault;
    await vault.waitForDeployment();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    token = (await MockERC20Factory.deploy("Mock USD", "mUSD")) as unknown as MockERC20;
    await token.waitForDeployment();

    const FeeTokenFactory = await ethers.getContractFactory("MockFeeOnTransferToken");
    feeToken = (await FeeTokenFactory.deploy()) as unknown as MockFeeOnTransferToken;
    await feeToken.waitForDeployment();
  });

  it("Should initialize controller once by admin and reject re-initialization", async function () {
    await expect(
      vault.connect(user).initializeController(controller.address)
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__Unauthorized");

    await expect(
      vault.connect(admin).initializeController(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__ZeroAddress");

    await expect(vault.connect(admin).initializeController(controller.address))
      .to.emit(vault, "ControllerInitialized")
      .withArgs(controller.address);

    expect(await vault.controller()).to.equal(controller.address);
    expect(await vault.controllerInitialized()).to.be.true;

    await expect(
      vault.connect(admin).initializeController(user.address)
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__ControllerAlreadySet");
  });

  it("Should accept ETH deposits and allow only controller to transfer ETH when unpaused", async function () {
    const amount = ethers.parseEther("2");
    await vault.connect(user).depositETH({ value: amount });
    expect(await vault.getBalance()).to.equal(amount);

    // Before controller is initialized
    await expect(
      vault.connect(controller).transferETH(recipient.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__ControllerNotSet");

    await vault.connect(admin).initializeController(controller.address);

    // Unauthorized caller cannot transfer
    await expect(
      vault.connect(user).transferETH(recipient.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__Unauthorized");

    // Pause blocks even direct controller transfer (no pause bypass)
    await emergencyPause.connect(guardian).pause();
    await expect(
      vault.connect(controller).transferETH(recipient.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");

    await emergencyPause.connect(admin).unpause();

    // Validations: zero address, zero amount, insufficient balance
    await expect(
      vault.connect(controller).transferETH(ethers.ZeroAddress, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__ZeroAddress");
    await expect(
      vault.connect(controller).transferETH(recipient.address, 0)
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__ZeroAmount");
    await expect(
      vault.connect(controller).transferETH(recipient.address, ethers.parseEther("5"))
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__InsufficientBalance");

    // Successful transfer
    await expect(vault.connect(controller).transferETH(recipient.address, ethers.parseEther("1")))
      .to.emit(vault, "FundsWithdrawn")
      .withArgs(recipient.address, ethers.parseEther("1"));

    expect(await vault.getBalance()).to.equal(ethers.parseEther("1"));
  });

  it("Should support standard ERC20 deposits/transfers and reject fee-on-transfer tokens", async function () {
    await vault.connect(admin).initializeController(controller.address);

    const amount = ethers.parseEther("100");
    await token.mint(user.address, amount);
    await token.connect(user).approve(await vault.getAddress(), amount);

    await expect(vault.connect(user).depositERC20(await token.getAddress(), amount))
      .to.emit(vault, "ERC20FundsDeposited")
      .withArgs(await token.getAddress(), user.address, amount);

    expect(await vault.getERC20Balance(await token.getAddress())).to.equal(amount);

    // Fee-on-transfer token must be rejected
    await feeToken.mint(user.address, amount);
    await feeToken.connect(user).approve(await vault.getAddress(), amount);

    await expect(
      vault.connect(user).depositERC20(await feeToken.getAddress(), amount)
    ).to.be.revertedWithCustomError(vault, "TreasuryVault__FeeOnTransferNotSupported");

    // Transfer ERC20 out via controller
    await expect(
      vault.connect(controller).transferERC20(await token.getAddress(), recipient.address, amount)
    )
      .to.emit(vault, "ERC20FundsWithdrawn")
      .withArgs(await token.getAddress(), recipient.address, amount);

    expect(await token.balanceOf(recipient.address)).to.equal(amount);
  });
});