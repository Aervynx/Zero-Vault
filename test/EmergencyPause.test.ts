/// <reference types="mocha" />
import { expect } from "chai";
import { ethers } from "hardhat";
import { RoleManager, EmergencyPauseMock } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("EmergencyPause Contract", function () {
    let roleManager: RoleManager;
    let emergencyPause: EmergencyPauseMock;
    let owner: HardhatEthersSigner;
    let guardian: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    beforeEach(async function () {
        const signers: HardhatEthersSigner[] = await ethers.getSigners();
        owner = signers[0];
        guardian = signers[1];
        user = signers[2];

        // 1. Deploy RoleManager
        const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
        roleManager = (await RoleManagerFactory.deploy(owner.address)) as unknown as RoleManager;
        await roleManager.waitForDeployment();

        // Grant Guardian Role
        const guardianRole = await roleManager.GUARDIAN_ROLE();
        await roleManager.grantRole(guardianRole, guardian.address);

        // 2. Deploy EmergencyPause Mock contract
        const EmergencyPauseFactory = await ethers.getContractFactory("EmergencyPauseMock");
        emergencyPause = (await EmergencyPauseFactory.deploy(await roleManager.getAddress())) as unknown as EmergencyPauseMock;
        await emergencyPause.waitForDeployment();
    });

    it("Should allow guardian to pause and admin to unpause", async function () {
        expect(await emergencyPause.paused()).to.be.false;

        // Guardian pauses
        await emergencyPause.connect(guardian).pause();
        expect(await emergencyPause.paused()).to.be.true;

        // Admin unpauses
        await emergencyPause.connect(owner).unpause();
        expect(await emergencyPause.paused()).to.be.false;
    });

    it("Should revert when non-guardian tries to pause", async function () {
        await expect(
            emergencyPause.connect(user).pause()
        ).to.be.reverted;
    });

    it("Should block protected functions when paused", async function () {
        await emergencyPause.connect(guardian).pause();

        await expect(
            emergencyPause.testActionWhenNotPaused()
        ).to.be.reverted;
    });
});