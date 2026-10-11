//! Independently deployed Pump plugins. No DAO reserve or voting instructions.
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

#[path = "../../shared/loader.rs"]
mod loader;
#[path = "../../shared/accounts.rs"]
mod accounts;
#[path = "../../shared/configuration.rs"]
mod configuration;
#[path = "./revenue.rs"]
mod revenue;
#[path = "../../shared/state.rs"]
mod state;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (tag, data) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0..=10 => revenue::process(program, accounts, *tag, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revenue_rejects_every_dao_operation() {
        for tag in 16..=20 {
            assert_eq!(
                process_instruction(&Pubkey::new_unique(), &[], &[tag]),
                Err(ProgramError::InvalidInstructionData)
            );
        }
    }
}
