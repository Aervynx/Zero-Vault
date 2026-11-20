import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { CollateralLending, MockERC20, MockERC4907, MockERC721 } from "../typechain-types";

describe("CollateralLending (ETH, ERC20 & Genesis NFT Loans + Grace Period & Default Liquidation)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60;
  const DAY = 24 * 60 * 60;
  const ETH_TYPE = 1;
  const ERC20_TYPE = 2;
  const ERC721_TYPE = 3;

  async function advanceTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function setupLending() {
    const [, admin, operator, executor, guardian, budgetManager, borrower, liquidator] =
      await ethers.getSigners();

    const deployment = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const loanToken = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "USD Coin",
      "USDC"
    )) as unknown as MockERC20;
    const collateralToken = (await (await ethers.getContractFactory("MockERC20")).deploy(
      "Wrapped RWA",
      "wRWA"
    )) as unknown as MockERC20;
    const genesisNft = (await (await ethers.getContractFactory("MockERC721")).deploy(
      "Aervynx Genesis NFT",
      "AGNFT"
    )) as unknown as MockERC721;

    const LendingFactory = await ethers.getContractFactory("CollateralLending");
    const lending = (await LendingFactory.deploy(
      await loanToken.getAddress(),
      deployment.addresses.roleManager,
      deployment.addresses.emergencyPause,
      deployment.addresses.vault,
      deployment.addresses.timelock
    )) as unknown as CollateralLending;
    await lending.waitForDeployment();
    const lendingAddr = await lending.getAddress();

    // Fund lending pool with 10,000 USDC
    await loanToken.mint(admin.address, ethers.parseEther("10000"));
    await loanToken.connect(admin).approve(lendingAddr, ethers.parseEther("10000"));
    await lending.connect(admin).fundPool(ethers.parseEther("10000"));

    // Configure ETH, ERC20, and Genesis NFT collateral policies
    await lending.connect(budgetManager).configureCollateral(ethers.ZeroAddress, {
      collateralType: ETH_TYPE,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("1500"),
      interestBps: 500, // 5%
      lateFeeBps: 200, // 2%
      gracePeriod: 3 * DAY,
    });

    await lending.connect(budgetManager).configureCollateral(await collateralToken.getAddress(), {
      collateralType: ERC20_TYPE,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("1"),
      interestBps: 400, // 4%
      lateFeeBps: 200,
      gracePeriod: 3 * DAY,
    });

    await lending.connect(budgetManager).configureCollateral(await genesisNft.getAddress(), {
      collateralType: ERC721_TYPE,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("500"),
      interestBps: 600, // 6%
      lateFeeBps: 200, // 2%
      gracePeriod: 3 * DAY,
    });

    return {
      ...deployment,
      lending,
      lendingAddr,
      loanToken,
      collateralToken,
      genesisNft,
      admin,
      operator,
      guardian,
      budgetManager,
      borrower,
      liquidator,
    };
  }

  it("Should allow ETH collateral 4-installment loan, permit repayment even during Pause, and release ETH on full repayment", async function () {
    const { lending, lendingAddr, loanToken, emergencyPause, guardian, borrower } =
      await setupLending();

    // Borrow 1000 USDC against 1 ETH (total owed = 1050 USDC in 4 installments)
    await lending
      .connect(borrower)
      .borrowWithETH(ethers.parseEther("1000"), 4, 30 * DAY, { value: ethers.parseEther("1") });

    expect(await loanToken.balanceOf(borrower.address)).to.equal(ethers.parseEther("1000"));

    await loanToken.mint(borrower.address, ethers.parseEther("100"));
    await loanToken.connect(borrower).approve(lendingAddr, ethers.parseEther("1100"));

    // Even while paused, borrower CAN repay installments so they never unfairly default
    await emergencyPause.connect(guardian).pause();
    await lending.connect(borrower).repayInstallment(1);

    // Pay remaining 3 installments on loan #1 -> ETH automatically released back to borrower
    await lending.connect(borrower).repayInstallment(1);
    await lending.connect(borrower).repayInstallment(1);
    await expect(lending.connect(borrower).repayInstallment(1))
      .to.emit(lending, "LoanRepaidInFull")
      .withArgs(1, borrower.address);

    const loan = await lending.loans(1);
    expect(loan.status).to.equal(2); // Repaid
  });

  it("Should protect Genesis NFT during Grace Period with late fee, and support both liquidator buyout and Treasury seizure on default", async function () {
    const {
      lending,
      lendingAddr,
      loanToken,
      collateralToken,
      genesisNft,
      operator,
      borrower,
      liquidator,
      addresses,
    } = await setupLending();

    // 1. Genesis NFT loan #1: 500 USDC in 2 installments
    await genesisNft.mint(borrower.address, 77);
    await genesisNft.connect(borrower).approve(lendingAddr, 77);
    await lending
      .connect(borrower)
      .borrowWithGenesisNFT(await genesisNft.getAddress(), 77, ethers.parseEther("500"), 2, 30 * DAY);

    expect(await genesisNft.ownerOf(77)).to.equal(lendingAddr);

    // Advance 31 days (still inside 3-day Grace Period) -> cannot liquidate yet
    await advanceTime(31 * DAY);
    expect(await lending.isDefaulted(1)).to.be.false;
    await expect(lending.connect(liquidator).liquidate(1)).to.be.revertedWithCustomError(
      lending,
      "CollateralLending__LoanNotDefaulted"
    );

    // Advance 3 more days (past Grace Period) -> now defaulted
    await advanceTime(3 * DAY);
    expect(await lending.isDefaulted(1)).to.be.true;

    // Path 2: Operator seizes defaulted Genesis NFT directly to TreasuryVault
    await expect(lending.connect(operator).seizeToTreasury(1))
      .to.emit(lending, "CollateralSeizedToTreasury")
      .withArgs(1, operator.address);
    expect(await genesisNft.ownerOf(77)).to.equal(addresses.vault);

    // 2. ERC20 collateral loan #2 -> Path 1: Liquidator repays debt + late fee and claims collateral
    await collateralToken.mint(borrower.address, ethers.parseEther("1000"));
    await collateralToken.connect(borrower).approve(lendingAddr, ethers.parseEther("1000"));
    await lending
      .connect(borrower)
      .borrowWithERC20(
        await collateralToken.getAddress(),
        ethers.parseEther("1000"),
        ethers.parseEther("500"),
        1,
        30 * DAY
      );

    await advanceTime(35 * DAY);
    expect(await lending.isDefaulted(2)).to.be.true;

    await loanToken.mint(liquidator.address, ethers.parseEther("600"));
    await loanToken.connect(liquidator).approve(lendingAddr, ethers.parseEther("600"));

    await expect(lending.connect(liquidator).liquidate(2)).to.emit(lending, "LoanLiquidated");
    expect(await collateralToken.balanceOf(liquidator.address)).to.equal(ethers.parseEther("1000"));
  });

  it("Should preserve ERC-4907 Genesis NFT abilities while healthy, expire on default, and support single-tx repayFull", async function () {
    const { lending, lendingAddr, loanToken, budgetManager, borrower } = await setupLending();

    const genesis4907 = (await (await ethers.getContractFactory("MockERC4907")).deploy(
      "Aervynx Genesis Utility NFT",
      "AGUNFT"
    )) as unknown as MockERC4907;
    await genesis4907.waitForDeployment();
    const nftAddr = await genesis4907.getAddress();

    await lending.connect(budgetManager).configureCollateral(nftAddr, {
      collateralType: ERC721_TYPE,
      enabled: true,
      maxLoanPerUnit: ethers.parseEther("500"),
      interestBps: 500, // 5%
      lateFeeBps: 200,
      gracePeriod: 3 * DAY,
    });

    // Lock Genesis NFT #1 -> borrower retains ERC-4907 user ability while loan is active
    await genesis4907.mint(borrower.address, 1);
    await genesis4907.connect(borrower).approve(lendingAddr, 1);
    await lending
      .connect(borrower)
      .borrowWithGenesisNFT(nftAddr, 1, ethers.parseEther("400"), 4, 30 * DAY);

    expect(await genesis4907.ownerOf(1)).to.equal(lendingAddr);
    expect(await genesis4907.userOf(1)).to.equal(borrower.address);

    // One-transaction full settlement via repayFull -> NFT ownership immediately returned
    await loanToken.mint(borrower.address, ethers.parseEther("100"));
    await loanToken.connect(borrower).approve(lendingAddr, ethers.parseEther("500"));

    await expect(lending.connect(borrower).repayFull(1))
      .to.emit(lending, "LoanRepaidInFull")
      .withArgs(1, borrower.address);

    expect(await genesis4907.ownerOf(1)).to.equal(borrower.address);

    // Lock Genesis NFT #2 -> miss due date + grace period -> utility auto-expires to address(0)
    await genesis4907.mint(borrower.address, 2);
    await genesis4907.connect(borrower).approve(lendingAddr, 2);
    await lending
      .connect(borrower)
      .borrowWithGenesisNFT(nftAddr, 2, ethers.parseEther("400"), 2, 30 * DAY);

    expect(await genesis4907.userOf(2)).to.equal(borrower.address);
    await advanceTime(34 * DAY); // Past 30-day due date + 3-day grace period
    expect(await genesis4907.userOf(2)).to.equal(ethers.ZeroAddress);
  });
});