import { expect } from "chai";
import { ethers } from "hardhat";
import { Treasury, TreasuryVault, RoleManager, RuneToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Treasury and TreasuryVault Comprehensive Suite", function () {
    let treasury: Treasury;
    let vault: TreasuryVault;
    let roleManager: RoleManager;
    let token: RuneToken;

    let deployer: HardhatEthersSigner;
    let guardian: HardhatEthersSigner;
    let timelock: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

    beforeEach(async function () {
        const signers = await ethers.getSigners();
        deployer = signers[0];
        guardian = signers[1];
        timelock = signers[2];
        user = signers[3];

        // 1. Deploy RoleManager
        const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
        roleManager = await RoleManagerFactory.deploy(deployer.address);
        await roleManager.waitForDeployment();

        await roleManager.grantRole(GUARDIAN_ROLE, guardian.address);

        // 2. Deploy Test ERC20 Token
        const TokenFactory = await ethers.getContractFactory("RuneToken");
        token = await TokenFactory.deploy(deployer.address);
        await token.waitForDeployment();

        // 3. Predict Treasury address to resolve immutable constructor dependency
        const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
        const predictedTreasuryAddress = ethers.getCreateAddress({
            from: deployer.address,
            nonce: deployerNonce + 1
        });

        // 4. Deploy TreasuryVault
        const VaultFactory = await ethers.getContractFactory("TreasuryVault");
        vault = await VaultFactory.deploy(predictedTreasuryAddress);
        await vault.waitForDeployment();

        // 5. Deploy Treasury
        const TreasuryFactory = await ethers.getContractFactory("Treasury");
        treasury = await TreasuryFactory.deploy(
            await vault.getAddress(),
            await roleManager.getAddress(),
            timelock.address
        );
        await treasury.waitForDeployment();

        expect(await treasury.getAddress()).to.equal(predictedTreasuryAddress);
    });

    it("Should deploy and link vault and timelock correctly", async function () {
        expect(await treasury.vault()).to.equal(await vault.getAddress());
        expect(await vault.CONTROLLER()).to.equal(await treasury.getAddress());
        expect(await treasury.timelock()).to.equal(timelock.address);
    });

    it("Should accept ETH deposits and update vault balance correctly", async function () {
        const depositAmount = ethers.parseEther("10.0");
        
        await expect(
            user.sendTransaction({
                to: await treasury.getAddress(),
                value: depositAmount
            })
        ).to.emit(treasury, "Deposited").withArgs(user.address, depositAmount);

        expect(await vault.getBalance()).to.equal(depositAmount);
    });

    it("Should accept explicit deposit function calls", async function () {
        const depositAmount = ethers.parseEther("5.0");

        await expect(
            treasury.connect(user).deposit({ value: depositAmount })
        ).to.emit(treasury, "Deposited").withArgs(user.address, depositAmount);

        expect(await vault.getBalance()).to.equal(depositAmount);
    });

    it("Should allow timelock to withdraw ETH securely", async function () {
        const depositAmount = ethers.parseEther("10.0");
        await user.sendTransaction({
            to: await treasury.getAddress(),
            value: depositAmount
        });

        const withdrawAmount = ethers.parseEther("3.0");
        const recipient = user.address;

        await deployer.sendTransaction({ to: timelock.address, value: ethers.parseEther("1.0") });
        const timelockSigner = await ethers.getImpersonatedSigner(timelock.address);

        await expect(
            treasury.connect(timelockSigner).withdraw(recipient, withdrawAmount)
        ).to.emit(treasury, "Withdrawn").withArgs(recipient, withdrawAmount);

        expect(await vault.getBalance()).to.equal(depositAmount - withdrawAmount);
    });

    it("Should revert ETH withdrawal when called by unauthorized accounts", async function () {
        await expect(
            treasury.connect(user).withdraw(user.address, ethers.parseEther("1.0"))
        ).to.be.revertedWithCustomError(treasury, "Treasury__Unauthorized");
    });

    it("Should allow timelock to withdraw ERC20 tokens safely", async function () {
        const tokenAmount = ethers.parseEther("1000");
        await token.mint(deployer.address, tokenAmount);
        await token.transfer(await vault.getAddress(), tokenAmount);
        expect(await vault.getERC20Balance(await token.getAddress())).to.equal(tokenAmount);

        const transferAmount = ethers.parseEther("250");
        await deployer.sendTransaction({ to: timelock.address, value: ethers.parseEther("1.0") });
        const timelockSigner = await ethers.getImpersonatedSigner(timelock.address);

        await expect(
            treasury.connect(timelockSigner).withdrawERC20(await token.getAddress(), user.address, transferAmount)
        ).to.emit(treasury, "ERC20Withdrawn").withArgs(await token.getAddress(), user.address, transferAmount);

        expect(await vault.getERC20Balance(await token.getAddress())).to.equal(tokenAmount - transferAmount);
    });

    it("Should block withdrawals when paused by a guardian", async function () {
        const depositAmount = ethers.parseEther("5.0");
        await user.sendTransaction({ to: await treasury.getAddress(), value: depositAmount });

        await treasury.connect(guardian).pause();
        expect(await treasury.paused()).to.be.true;

        await deployer.sendTransaction({ to: timelock.address, value: ethers.parseEther("1.0") });
        const timelockSigner = await ethers.getImpersonatedSigner(timelock.address);

        await expect(
            treasury.connect(timelockSigner).withdraw(user.address, ethers.parseEther("1.0"))
        ).to.be.reverted;
    });
});