//! Local-validator fixture only. This is NOT Pump's implementation and must never be deployed.
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};
solana_program::entrypoint!(process);
pub fn process(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let pump = solana_program::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    if data == [160, 57, 89, 42, 181, 139, 43, 66] {
        let (vault, bump) =
            Pubkey::find_program_address(&[b"creator_vault", a[2].key.as_ref()], program);
        if a[3].key != &vault {
            return Err(ProgramError::InvalidArgument);
        }
        let amount = u64::from_le_bytes(a[4].try_borrow_data()?[64..72].try_into().unwrap());
        let ix = spl_token::instruction::transfer_checked(
            a[1].key,
            a[4].key,
            a[0].key,
            a[5].key,
            a[3].key,
            &[],
            amount,
            9,
        )?;
        return invoke_signed(
            &ix,
            &[
                a[4].clone(),
                a[0].clone(),
                a[5].clone(),
                a[3].clone(),
                a[1].clone(),
            ],
            &[&[b"creator_vault", a[2].key.as_ref(), &[bump]]],
        );
    }
    if program != &pump && data.len() >= 24 && data[..8] == [102, 6, 61, 18, 1, 218, 235, 234] {
        let amount = u64::from_le_bytes(data[8..16].try_into().unwrap());
        let cost = u64::from_le_bytes(data[16..24].try_into().unwrap());
        let creator =
            Pubkey::find_program_address(&[b"pool-authority", a[3].key.as_ref()], &pump).0;
        let seeds: &[&[u8]] = &[
            b"pool",
            &0u16.to_le_bytes(),
            creator.as_ref(),
            a[3].key.as_ref(),
            a[4].key.as_ref(),
        ];
        let (pool, bump) = Pubkey::find_program_address(seeds, program);
        if a[0].key != &pool {
            return Err(ProgramError::InvalidArgument);
        }
        let pay = spl_token::instruction::transfer_checked(
            a[12].key,
            a[6].key,
            a[4].key,
            a[8].key,
            a[1].key,
            &[],
            cost,
            9,
        )?;
        invoke(
            &pay,
            &[
                a[6].clone(),
                a[4].clone(),
                a[8].clone(),
                a[1].clone(),
                a[12].clone(),
            ],
        )?;
        let deliver = spl_token_2022::instruction::transfer_checked(
            a[11].key,
            a[7].key,
            a[3].key,
            a[5].key,
            a[0].key,
            &[],
            amount,
            6,
        )?;
        let bump = [bump];
        let mut signing = seeds.to_vec();
        signing.push(&bump);
        return invoke_signed(
            &deliver,
            &[
                a[7].clone(),
                a[3].clone(),
                a[5].clone(),
                a[0].clone(),
                a[11].clone(),
            ],
            &[&signing],
        );
    }
    if data == [207, 17, 138, 242, 4, 34, 19, 56] {
        let vault = Pubkey::find_program_address(&[b"creator-vault", a[0].key.as_ref()], program).0;
        if a[2].key != &vault || a[2].owner != program {
            return Err(ProgramError::InvalidArgument);
        }
        let amount = a[2].lamports().saturating_sub(1_000_000);
        **a[2].try_borrow_mut_lamports()? -= amount;
        **a[0].try_borrow_mut_lamports()? += amount;
        return Ok(());
    }
    if data.len() == 24 && data[..8] == [184, 23, 238, 97, 103, 197, 211, 61] {
        let amount = u64::from_le_bytes(data[8..16].try_into().unwrap());
        let cost = u64::from_le_bytes(data[16..24].try_into().unwrap());
        let (curve, bump) =
            Pubkey::find_program_address(&[b"bonding-curve", a[1].key.as_ref()], program);
        if a[10].key != &curve {
            return Err(ProgramError::InvalidArgument);
        }
        invoke(
            &system_instruction::transfer(a[13].key, a[10].key, cost),
            &[a[13].clone(), a[10].clone(), a[24].clone()],
        )?;
        let ix = spl_token_2022::instruction::transfer_checked(
            a[3].key,
            a[11].key,
            a[1].key,
            a[14].key,
            a[10].key,
            &[],
            amount,
            6,
        )?;
        return invoke_signed(
            &ix,
            &[
                a[11].clone(),
                a[1].clone(),
                a[14].clone(),
                a[10].clone(),
                a[3].clone(),
            ],
            &[&[b"bonding-curve", a[1].key.as_ref(), &[bump]]],
        );
    }
    Err(ProgramError::InvalidInstructionData)
}
