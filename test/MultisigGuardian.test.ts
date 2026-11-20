import { expect } from "chai";
import { ethers } from "hardhat";
import { deployZeroVault } from "../scripts/deploy";
import { MultiSigGuardian } from "../typechain-types";

describe("MultiSigGuardian (M-of-N Critical Operations & Fast Emergency Pause)", function () {
  const INITIAL_DELAY = 2 * 24 * 60 * 60;

  it("Should allow 1-of-3 fast emergency pause, require 2-of-3 to unpause, and block replay", async function () {
    const [, admin, operator, executor, guardian, budgetManager, s1, s2, s3, outsider] =
      await ethers.getSigners();

    const { roleManager, emergencyPause, addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const MultiSigFactory = await ethers.getContractFactory("MultiSigGuardian");
    const multisig = (await MultiSigFactory.deploy(
      addresses.emergencyPause,
      [s1.address, s2.address, s3.address],
      2
    )) as unknown as MultiSigGuardian;
    await multisig.waitForDeployment();
    const multisigAddr = await multisig.getAddress();

    // Transfer DEFAULT_ADMIN_ROLE to MultiSigGuardian and renounce single-EOA admin
    const DEFAULT_ADMIN_ROLE = await roleManager.DEFAULT_ADMIN_ROLE();
    await roleManager.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, multisigAddr);
    await roleManager.connect(admin).renounceRole(DEFAULT_ADMIN_ROLE, admin.address);

    // Outsider cannot trigger pause
    await expect(
      multisig.connect(outsider).triggerEmergencyPause()
    ).to.be.revertedWithCustomError(multisig, "MultiSigGuardian__NotSigner");

    // 1. Fast 1-of-3 emergency pause succeeds immediately
    await expect(multisig.connect(s1).triggerEmergencyPause())
      .to.emit(multisig, "FastEmergencyPauseTriggered")
      .withArgs(s1.address);
    expect(await emergencyPause.paused()).to.be.true;

    // 2. Single signer proposes unpause (1/2 confirmations) -> execution must fail
    const unpauseData = emergencyPause.interface.encodeFunctionData("unpause");
    await multisig
      .connect(s1)
      .proposeAction(addresses.emergencyPause, 0, unpauseData, "Unpause after incident review");

    await expect(multisig.connect(s1).executeAction(1)).to.be.revertedWithCustomError(
      multisig,
      "MultiSigGuardian__InsufficientConfirmations"
    );

    // 3. Second signer confirms -> revokes -> confirms again
    await multisig.connect(s2).confirmAction(1);
    await multisig.connect(s2).revokeConfirmation(1);
    await expect(multisig.connect(s1).executeAction(1)).to.be.revertedWithCustomError(
      multisig,
      "MultiSigGuardian__InsufficientConfirmations"
    );

    await multisig.connect(s3).confirmAction(1);

    // 4. 2-of-3 threshold met -> unpause executes cleanly
    await expect(multisig.connect(s3).executeAction(1))
      .to.emit(multisig, "ActionExecuted")
      .withArgs(1, s3.address);
    expect(await emergencyPause.paused()).to.be.false;

    // 5. Replay blocked
    await expect(multisig.connect(s1).executeAction(1)).to.be.revertedWithCustomError(
      multisig,
      "MultiSigGuardian__AlreadyExecuted"
    );
  });

  it("Should require M-of-N self-governance to change threshold or signers", async function () {
    const [, admin, operator, executor, guardian, budgetManager, s1, s2, s3] =
      await ethers.getSigners();

    const { addresses } = await deployZeroVault({
      admin: admin.address,
      operator: operator.address,
      executor: executor.address,
      guardian: guardian.address,
      budgetManager: budgetManager.address,
      initialDelay: INITIAL_DELAY,
      silent: true,
    });

    const MultiSigFactory = await ethers.getContractFactory("MultiSigGuardian");
    const multisig = (await MultiSigFactory.deploy(
      addresses.emergencyPause,
      [s1.address, s2.address, s3.address],
      2
    )) as unknown as MultiSigGuardian;
    await multisig.waitForDeployment();
    const multisigAddr = await multisig.getAddress();

    // Direct call to changeThreshold fails
    await expect(multisig.connect(s1).changeThreshold(3)).to.be.revertedWithCustomError(
      multisig,
      "MultiSigGuardian__OnlySelf"
    );

    // Must go through 2-of-3 M-of-N action
    const data = multisig.interface.encodeFunctionData("changeThreshold", [3]);
    await multisig.connect(s1).proposeAction(multisigAddr, 0, data, "Raise threshold to 3-of-3");
    await multisig.connect(s2).confirmAction(1);
    await multisig.connect(s2).executeAction(1);

    expect(await multisig.threshold()).to.equal(3);
  });
});