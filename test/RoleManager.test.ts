///<reference types="mocha" />
import { expect } from "chai";
import { ethers } from "hardhat";
import { RoleManager } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("RoleManager Contract", function () {
    let roleManager: RoleManager;
    let owner: HardhatEthersSigner;
    let guardian: HardhatEthersSigner;
    let operator: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    beforeEach(async function () {
        const signers: HardhatEthersSigner[] = await ethers.getSigners();
        owner = signers[0];
        guardian = signers[1];
        operator = signers[2];
        user = signers[3];

        const RoleManagerFactory = await ethers.getContractFactory("RoleManager");
        roleManager = (await RoleManagerFactory.deploy(owner.address)) as unknown as RoleManager;
        await roleManager.waitForDeployment();
    });

    it("Should set the correct deployer as default admin", async function () {
        const adminRole = await roleManager.DEFAULT_ADMIN_ROLE();
        expect(await roleManager.hasRole(adminRole, owner.address)).to.be.true;
    });

    it("Should allow admin to grant Guardian and Operator roles", async function () {
        const guardianRole = await roleManager.GUARDIAN_ROLE();
        const operatorRole = await roleManager.OPERATOR_ROLE();

        await roleManager.grantRole(guardianRole, guardian.address);
        await roleManager.grantRole(operatorRole, operator.address);

        expect(await roleManager.hasRole(guardianRole, guardian.address)).to.be.true;
        expect(await roleManager.hasRole(operatorRole, operator.address)).to.be.true;
    });

    it("Should revert when non-admin tries to grant roles", async function () {
        const guardianRole = await roleManager.GUARDIAN_ROLE();

        await expect(
            roleManager.connect(user).grantRole(guardianRole, user.address)
        ).to.be.reverted;
    });
});