import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EmergencyPause,
  MockERC20,
  MockFeeOnTransferToken,
  RoleManager,
  Treasury,
  TreasuryVault,
} from "../typechain-types";

describe("Treasury and TreasuryVault Comprehensive Suite", function () {
  let roleManager: RoleManager;
  let emergencyPause: EmergencyPause;
  let vault: TreasuryVault;
  let treasury: Treasury;
  let token: MockERC20;
  let feeToken: MockFeeOnTransferToken;

  let admin: any;
  let timelockSigner: any;
  let operator: any;
  let guardian: any;
  let user: any;
  let recipient: any;

  beforeEach(async function () {
    [admin, timelockSigner, operator, guardian, user, recipient] = await ethers.getSigners();

    const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
    roleManager = (await RoleManagerFactory.deploy(admin.address)) as unknown as RoleManager;
    await roleManager.waitForDeployment();

    await roleManager.connect(admin).grantRole(await roleManager.OPERATOR_ROLE(), operator.address);
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

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = (await TreasuryFactory.deploy(
      await vault.getAddress(),
      await roleManager.getAddress(),
      await emergencyPause.getAddress(),
      timelockSigner.address
    )) as unknown as Treasury;
    await treasury.waitForDeployment();

    await vault.connect(admin).initializeController(await treasury.getAddress());

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    token = (await MockERC20Factory.deploy("Mock USD", "mUSD")) as unknown as MockERC20;
    await token.waitForDeployment();

    const FeeTokenFactory = await ethers.getContractFactory("MockFeeOnTransferToken");
    feeToken = (await FeeTokenFactory.deploy()) as unknown as MockFeeOnTransferToken;
    await feeToken.waitForDeployment();
  });

  it("Should deploy and link vault, pause registry, and timelock correctly", async function () {
    expect(await treasury.vault()).to.equal(await vault.getAddress());
    expect(await treasury.timelock()).to.equal(timelockSigner.address);
    expect(await treasury.emergencyPause()).to.equal(await emergencyPause.getAddress());
    expect(await vault.controller()).to.equal(await treasury.getAddress());
  });

  it("Should accept ETH via explicit deposit and direct receive", async function () {
    const amount = ethers.parseEther("1.5");

    await expect(treasury.connect(user).deposit({ value: amount }))
      .to.emit(treasury, "Deposited")
      .withArgs(user.address, amount);

    await expect(user.sendTransaction({ to: await treasury.getAddress(), value: amount }))
      .to.emit(treasury, "Deposited")
      .withArgs(user.address, amount);

    expect(await vault.getBalance()).to.equal(ethers.parseEther("3"));

    await expect(treasury.connect(user).deposit({ value: 0 })).to.be.revertedWithCustomError(
      treasury,
      "Treasury__ZeroDeposit"
    );
  });

  it("Should accept standard ERC20 deposits and reject fee-on-transfer tokens", async function () {
    const amount = ethers.parseEther("250");
    await token.mint(user.address, amount);
    await token.connect(user).approve(await treasury.getAddress(), amount);

    await expect(treasury.connect(user).depositERC20(await token.getAddress(), amount))
      .to.emit(treasury, "ERC20Deposited")
      .withArgs(await token.getAddress(), user.address, amount);

    expect(await vault.getERC20Balance(await token.getAddress())).to.equal(amount);

    await feeToken.mint(user.address, amount);
    await feeToken.connect(user).approve(await treasury.getAddress(), amount);

    await expect(
      treasury.connect(user).depositERC20(await feeToken.getAddress(), amount)
    ).to.be.revertedWithCustomError(treasury, "Treasury__FeeOnTransferNotSupported");
  });

  it("Should allow only timelock to withdraw ETH and ERC20 when unpaused", async function () {
    const ethAmount = ethers.parseEther("2");
    const tokenAmount = ethers.parseEther("100");

    await treasury.connect(user).deposit({ value: ethAmount });
    await token.mint(user.address, tokenAmount);
    await token.connect(user).approve(await treasury.getAddress(), tokenAmount);
    await treasury.connect(user).depositERC20(await token.getAddress(), tokenAmount);

    // Unauthorized withdrawal must fail
    await expect(
      treasury.connect(user).withdraw(recipient.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(treasury, "Treasury__Unauthorized");

    // Pause blocks withdrawals
    await emergencyPause.connect(guardian).pause();
    await expect(
      treasury.connect(timelockSigner).withdraw(recipient.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(emergencyPause, "EmergencyPause__EnforcedPause");

    await emergencyPause.connect(admin).unpause();

    // Valid withdrawals succeed
    await expect(
      treasury.connect(timelockSigner).withdraw(recipient.address, ethers.parseEther("1"))
    )
      .to.emit(treasury, "Withdrawn")
      .withArgs(recipient.address, ethers.parseEther("1"));

    await expect(
      treasury
        .connect(timelockSigner)
        .withdrawERC20(await token.getAddress(), recipient.address, tokenAmount)
    )
      .to.emit(treasury, "ERC20Withdrawn")
      .withArgs(await token.getAddress(), recipient.address, tokenAmount);

    expect(await token.balanceOf(recipient.address)).to.equal(tokenAmount);
  });

  it("Should enforce withdrawal request lifecycle and allow guardian cancellation while paused", async function () {
    await treasury.connect(user).deposit({ value: ethers.parseEther("3") });

    // Unauthorized user cannot request withdrawal
    await expect(
      treasury.connect(user).requestETHWithdrawal(recipient.address, ethers.parseEther("1"), "Ops")
    ).to.be.revertedWithCustomError(treasury, "Treasury__Unauthorized");

    // Operator requests ETH withdrawal
    await expect(
      treasury
        .connect(operator)
        .requestETHWithdrawal(recipient.address, ethers.parseEther("1"), "Infra")
    ).to.emit(treasury, "WithdrawalRequested");

    // Operator cannot execute directly
    await expect(treasury.connect(operator).executeWithdrawal(1)).to.be.revertedWithCustomError(
      treasury,
      "Treasury__Unauthorized"
    );

    // Timelock executes request #1
    await expect(treasury.connect(timelockSigner).executeWithdrawal(1))
      .to.emit(treasury, "WithdrawalExecuted")
      .withArgs(1, ethers.ZeroAddress, recipient.address, ethers.parseEther("1"));

    // Duplicate execution reverts
    await expect(
      treasury.connect(timelockSigner).executeWithdrawal(1)
    ).to.be.revertedWithCustomError(treasury, "Treasury__InvalidRequestState");

    // Second request cancelled by guardian while paused
    await treasury
      .connect(operator)
      .requestETHWithdrawal(recipient.address, ethers.parseEther("1"), "Suspicious");

    await emergencyPause.connect(guardian).pause();
    await expect(treasury.connect(guardian).cancelWithdrawalRequest(2))
      .to.emit(treasury, "WithdrawalCancelled")
      .withArgs(2, guardian.address);

    await emergencyPause.connect(admin).unpause();
    await expect(
      treasury.connect(timelockSigner).executeWithdrawal(2)
    ).to.be.revertedWithCustomError(treasury, "Treasury__InvalidRequestState");
  });
});