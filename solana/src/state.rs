use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

pub type Result<T> = core::result::Result<T, ProgramError>;
pub fn require(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}
pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(ProgramError::ArithmeticOverflow)
}
pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or(ProgramError::InsufficientFunds)
}
pub fn ratio(a: u64, n: u64, d: u64) -> Result<u64> {
    u64::try_from(
        (a as u128)
            .checked_mul(n as u128)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_div(d as u128)
            .ok_or(ProgramError::InvalidArgument)?,
    )
    .map_err(|_| ProgramError::ArithmeticOverflow)
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Config {
    pub authority: Pubkey,
    pub platform: Pubkey,
    /// 0: existing platform 1%; 1: deduct 1%, then allocate the remaining 99%.
    pub bounty_source: u8,
    pub minimum: u64,
    pub maximum: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct Project {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub hook: Pubkey,
    pub reserve_recipient: Pubkey,
    pub buyback: bool,
    pub distribution: bool,
    pub platform: bool,
    pub nonce: u64,
    pub received: u64,
    /// Own buyback, platform buyback, distributions, project reserve, platform operations.
    pub balances: [u64; 5],
    pub bounty: u64,
    pub bounty_paid: u64,
    pub spent: u64,
    pub reward_tokens: u64,
    pub reward_cost: u64,
    pub burned: u64,
    pub platform_burned: u64,
    pub recipients_paid: u64,
}
impl Project {
    pub fn reserved(&self) -> Result<u64> {
        self.balances
            .iter()
            .try_fold(self.bounty, |a, b| add(a, *b))
    }
    pub fn work(&self) -> Result<u64> {
        add(
            if self.buyback {
                add(self.balances[0], self.balances[1])?
            } else {
                0
            },
            if self.distribution {
                add(self.balances[2], self.reward_cost)?
            } else {
                0
            },
        )
    }
    pub fn credit(&mut self, amount: u64, source: u8) -> Result<()> {
        require(amount > 0 && source <= 1)?;
        let bounty = amount / 100;
        let base = if source == 1 {
            sub(amount, bounty)?
        } else {
            amount
        };
        let shares = [
            ratio(base, if self.platform { 94 } else { 83 }, 100)?,
            if self.platform {
                0
            } else {
                ratio(base, 7, 100)?
            },
            ratio(base, 5, 100)?,
            if self.platform {
                0
            } else {
                ratio(base, 4, 100)?
            },
            if source == 1 { base / 100 } else { 0 },
        ];
        let allocated = shares.iter().try_fold(bounty, |a, b| add(a, *b))?;
        for (i, value) in shares.into_iter().enumerate() {
            self.balances[i] = add(self.balances[i], value)?;
        }
        // Rounding remains in buyback, never inflates the caller's one-percent reward.
        self.balances[0] = add(self.balances[0], sub(amount, allocated)?)?;
        self.bounty = add(self.bounty, bounty)?;
        self.received = add(self.received, amount)?;
        self.conserve()
    }
    pub fn settle_work(&mut self, cost: u64, work_before: u64) -> Result<u64> {
        require(cost > 0 && cost <= work_before)?;
        let reward = ratio(self.bounty, cost, work_before)?;
        self.bounty = sub(self.bounty, reward)?;
        self.bounty_paid = add(self.bounty_paid, reward)?;
        Ok(reward)
    }
    pub fn conserve(&self) -> Result<()> {
        require(add(add(self.reserved()?, self.spent)?, self.bounty_paid)? == self.received)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Governance {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub team: Pubkey,
    pub token_program: Pubkey,
    pub initial: u64,
    pub remaining: u64,
    pub genesis: i64,
    /// Explicit immutable policy: 0 = initial locked amount, 1 = remaining locked amount.
    pub release_basis: u8,
    pub quorum: u64,
    pub weight_cap_seconds: u32,
    pub next_round: u64,
    pub active: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct Round {
    pub governance: Pubkey,
    pub number: u64,
    pub end: i64,
    pub pot: u64,
    pub yes: u128,
    pub no: u128,
    pub yes_stake: u64,
    pub no_stake: u64,
    /// 0=open, 1=satisfied, 2=not satisfied, 3=void.
    pub outcome: u8,
    pub reward_remaining: u64,
    pub weight_remaining: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct Vote {
    pub round: Pubkey,
    pub voter: Pubkey,
    pub support: bool,
    pub stake: u64,
    pub weight: u128,
    pub withdrawn: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_and_completion_conserve_lamports() {
        for source in [0, 1] {
            for platform in [false, true] {
                for amount in [1, 99, 100, 10_000, u64::MAX] {
                    let mut p = Project {
                        buyback: true,
                        distribution: true,
                        platform,
                        ..Project::default()
                    };
                    p.credit(amount, source).unwrap();
                    assert_eq!(p.bounty, amount / 100);
                    let work = p.work().unwrap();
                    if work > 0 {
                        assert_eq!(p.settle_work(work, work).unwrap(), amount / 100);
                    }
                    p.conserve().unwrap();
                }
            }
        }
        let mut p = Project {
            buyback: true,
            distribution: true,
            ..Project::default()
        };
        p.credit(10_000, 0).unwrap();
        assert_eq!(p.balances, [8300, 700, 500, 400, 0]);
        let work = p.work().unwrap();
        p.balances[0] -= 8300;
        p.spent += 8300;
        assert_eq!(p.settle_work(8300, work).unwrap(), 87);
        p.conserve().unwrap();
        assert_eq!(p.bounty, 13);
    }
}
