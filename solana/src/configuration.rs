use crate::{accounts::*, state::*};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct Args {
    pub bounty_source: u8,
    pub minimum: u64,
    pub maximum: u64,
}

// Each deployed program owns its own immutable configuration and authority namespace.
pub fn initialize(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> Result<()> {
    require(a.len() == 6)?;
    let v = Args::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    signer(&a[1])?;
    wallet(&a[1])?;
    mint(&a[3])?;
    curve(&a[4], a[3].key, None)?;
    require(
        v.bounty_source <= 1
            && v.minimum > 0
            && v.minimum <= v.maximum
            && v.maximum <= 1_000_000_000,
    )?;
    let c = Config {
        authority: *a[1].key,
        platform: *a[3].key,
        bounty_source: v.bounty_source,
        minimum: v.minimum,
        maximum: v.maximum,
    };
    create(
        program,
        &a[0],
        &a[2],
        &a[5],
        &[b"config", a[1].key.as_ref()],
        1,
        &c,
    )
}
