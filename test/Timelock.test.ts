/// <reference types="mocha" />
import { expect } from "chai";
import { ethers } from "hardhat";
import { RoleManager, Timelock } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Timelock Contract", function () {
    let roleManager: RoleManager;
    let timelock: Timelock;
    let owner: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    const MIN_DELAY = 86400; // 1 day in seconds

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
    });

    it("Should queue a transaction correctly", async function () {
        const target = user.address;
        const value = 0;
        const signature = "setValue(uint256)";
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100]);
        
        const blockTimestamp = await time.latest();
        const eta = blockTimestamp + MIN_DELAY + 100;

        const txHash = await timelock.queueTransaction.staticCall(target, value, signature, data, eta);
        await timelock.queueTransaction(target, value, signature, data, eta);

        expect(await timelock.queuedTransactions(txHash)).to.be.true;
    });

    it("Should revert execution if timelock has not expired", async function () {
        const target = user.address;
        const value = 0;
        const signature = "";
        const data = "0x";
        
        const blockTimestamp = await time.latest();
        const eta = blockTimestamp + MIN_DELAY + 100;

        await timelock.queueTransaction(target, value, signature, data, eta);
        
        const txHash = ethers.keccak256(
            ethers.solidityPacked(
                ["address", "uint256", "string", "bytes", "uint256"],
                [target, value, signature, data, eta]
            )
        );

        await expect(
            timelock.executeTransaction(target, value, signature, data, eta)
        ).to.be.reverted; // Timelock__TxNotReady
    });
});