/// <reference types="mocha" />
import { expect } from "chai";
import { ethers } from "hardhat";
import { RoleManager, TreasuryVault, Timelock, Treasury } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Treasury Integration & End-to-End Workflow", function () {
    let roleManager: RoleManager;
    let vault: TreasuryVault;
    let timelock: Timelock;
    let treasury: Treasury;

    let owner: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    const MIN_DELAY = 86400; // 1 day

    beforeEach(async function () {
        const signers: HardhatEthersSigner[] = await ethers.getSigners();
        owner = signers[0];
        user = signers[1];

        // 1. Deploy RoleManager
        const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
        roleManager = (await RoleManagerFactory.deploy(owner.address)) as unknown as RoleManager;
        await roleManager.waitForDeployment();

        // 2. Deploy Timelock
        const TimelockFactory = await ethers.getContractFactory("Timelock");
        timelock = (await TimelockFactory.deploy(await roleManager.getAddress(), MIN_DELAY)) as unknown as Timelock;
        await timelock.waitForDeployment();

        // 3. Deploy TreasuryVault
        const TreasuryVaultFactory = await ethers.getContractFactory("TreasuryVault");
        vault = (await TreasuryVaultFactory.deploy(owner.address)) as unknown as TreasuryVault;
        await vault.waitForDeployment();

        // 4. Deploy Treasury
        const TreasuryFactory = await ethers.getContractFactory("Treasury");
        treasury = (await TreasuryFactory.deploy(
            await vault.getAddress(),
            await roleManager.getAddress()
        )) as unknown as Treasury;
        await treasury.waitForDeployment();
    });

    it("Should deploy all integrated contracts successfully", async function () {
        expect(await treasury.getAddress()).to.be.properAddress;
        expect(await vault.getAddress()).to.be.properAddress;
        expect(await timelock.getAddress()).to.be.properAddress;
    });
});