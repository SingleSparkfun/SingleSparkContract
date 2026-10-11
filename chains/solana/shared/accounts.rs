use crate::state::{require, Result};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::{Account, AccountState, Mint},
};

pub const ATA: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const PUMP: Pubkey = solana_program::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const AMM: Pubkey = solana_program::pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const NATIVE: Pubkey = spl_token::native_mint::ID;

pub fn signing_address(key: &Pubkey) -> bool {
    key != &Pubkey::default()
        && solana_curve25519::edwards::validate_edwards(
            &solana_curve25519::edwards::PodEdwardsPoint(key.to_bytes()),
        )
}

pub fn signer(a: &AccountInfo) -> Result<()> {
    if !a.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}
pub fn wallet(a: &AccountInfo) -> Result<()> {
    require(
        a.owner == &system_program::ID
            && a.data_is_empty()
            && !a.executable
            && signing_address(a.key),
    )
}
pub fn pda(program: &Pubkey, a: &AccountInfo, seeds: &[&[u8]]) -> Result<u8> {
    let (key, bump) = Pubkey::find_program_address(seeds, program);
    require(a.key == &key)?;
    Ok(bump)
}
pub fn load<T: BorshDeserialize>(program: &Pubkey, a: &AccountInfo, tag: u8) -> Result<T> {
    require(a.owner == program && !a.executable)?;
    let data = a.try_borrow_data()?;
    require(data.first() == Some(&tag))?;
    T::try_from_slice(&data[1..]).map_err(|_| ProgramError::InvalidAccountData)
}
pub fn save<T: BorshSerialize>(a: &AccountInfo, tag: u8, value: &T) -> Result<()> {
    require(a.is_writable)?;
    let mut data = a.try_borrow_mut_data()?;
    require(!data.is_empty())?;
    data[0] = tag;
    value
        .serialize(&mut &mut data[1..])
        .map_err(|_| ProgramError::AccountDataTooSmall)
}
pub fn create<'a, T: BorshSerialize>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    tag: u8,
    value: &T,
) -> Result<()> {
    signer(payer)?;
    require(
        system.key == &system_program::ID
            && account.owner == &system_program::ID
            && account.data_is_empty(),
    )?;
    let bump = pda(program, account, seeds)?;
    let bytes = borsh::to_vec(value).map_err(|_| ProgramError::InvalidAccountData)?;
    let size = bytes.len() + 1;
    let rent = Rent::get()?
        .minimum_balance(size)
        .saturating_sub(account.lamports());
    transfer_sol(payer, account, system, rent)?;
    let mut signing = seeds.to_vec();
    let bump = [bump];
    signing.push(&bump);
    invoke_signed(
        &system_instruction::allocate(account.key, size as u64),
        &[account.clone(), system.clone()],
        &[&signing],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, program),
        &[account.clone(), system.clone()],
        &[&signing],
    )?;
    save(account, tag, value)
}
pub fn transfer_sol<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    amount: u64,
) -> Result<()> {
    require(system.key == &system_program::ID && from.key != to.key)?;
    if amount == 0 {
        return Ok(());
    }
    invoke(
        &system_instruction::transfer(from.key, to.key, amount),
        &[from.clone(), to.clone(), system.clone()],
    )
}
pub fn mint(a: &AccountInfo) -> Result<Mint> {
    require(a.owner == &spl_token::ID || a.owner == &spl_token_2022::ID)?;
    let data = a.try_borrow_data()?;
    let value = StateWithExtensions::<Mint>::unpack(&data)?;
    require(
        value.base.is_initialized
            && value.base.decimals == 6
            && value.base.freeze_authority.is_none(),
    )?;
    require(value.get_extension_types()?.iter().all(|t| {
        matches!(
            t,
            ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
        )
    }))?;
    Ok(value.base)
}
pub fn token(a: &AccountInfo, mint: &Pubkey, owner: &Pubkey, program: &Pubkey) -> Result<u64> {
    require(a.owner == program && (program == &spl_token::ID || program == &spl_token_2022::ID))?;
    let data = a.try_borrow_data()?;
    let value = StateWithExtensions::<Account>::unpack(&data)?;
    let base = value.base;
    require(
        base.mint == *mint
            && base.owner == *owner
            && base.state == AccountState::Initialized
            && base.delegate.is_none()
            && (base.close_authority.is_none() || base.close_authority == Some(*owner).into()),
    )?;
    require(
        value
            .get_extension_types()?
            .iter()
            .all(|t| *t == ExtensionType::ImmutableOwner),
    )?;
    Ok(base.amount)
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), program.as_ref(), mint.as_ref()], &ATA).0
}
pub fn transfer_tokens<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    program: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    require(from.key != to.key && program.key == mint.owner)?;
    if amount == 0 {
        return Ok(());
    }
    let ix = spl_token_2022::instruction::transfer_checked(
        program.key,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
        6,
    )?;
    let signing = [seeds];
    invoke_signed(
        &ix,
        &[
            from.clone(),
            mint.clone(),
            to.clone(),
            authority.clone(),
            program.clone(),
        ],
        if seeds.is_empty() { &[] } else { &signing },
    )
}
pub fn burn<'a>(
    account: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    program: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    require(program.key == mint.owner && amount > 0)?;
    let ix = spl_token_2022::instruction::burn_checked(
        program.key,
        account.key,
        mint.key,
        authority.key,
        &[],
        amount,
        6,
    )?;
    let signing = [seeds];
    invoke_signed(
        &ix,
        &[
            account.clone(),
            mint.clone(),
            authority.clone(),
            program.clone(),
        ],
        if seeds.is_empty() { &[] } else { &signing },
    )
}
pub fn curve(account: &AccountInfo, mint: &Pubkey, creator: Option<&Pubkey>) -> Result<u64> {
    require(
        account.owner == &PUMP
            && account.key
                == &Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP).0,
    )?;
    let data = account.try_borrow_data()?;
    require(
        data.len() >= 125
            && data[..8] == [23, 183, 248, 55, 96, 216, 172, 96]
            && data[48] <= 1
            && data[81] == 0
            && data[82] == 0
            && data[83..115] == [0; 32]
            && data[124] == 0,
    )?;
    if let Some(creator) = creator {
        require(&data[49..81] == creator.as_ref())?;
    }
    let supply = u64::from_le_bytes(data[40..48].try_into().unwrap());
    require(supply > 0)?;
    Ok(supply)
}
