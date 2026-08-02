import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const MIN_DELAY = 86400;

export default buildModule("TreasuryModule", (m) => {
    const deployer = m.getAccount(0);
    const roleManager = m.contract("RoleManager", [deployer]);
    const timelock = m.contract("Timelock", [roleManager, MIN_DELAY]);
    const vault = m.contract("TreasuryVault", [deployer]);
    const treasury = m.contract("Treasury", [vault, roleManager]);
    return { roleManager, timelock, vault, treasury };
});