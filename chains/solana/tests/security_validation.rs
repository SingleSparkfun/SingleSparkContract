use borsh::BorshDeserialize;
use singlespark_solana::{
    revenue,
    state::{Config, Project},
};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

struct Account {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
    signer: bool,
}

impl Account {
    fn info(&mut self) -> AccountInfo<'_> {
        AccountInfo::new(
            &self.key,
            self.signer,
            true,
            &mut self.lamports,
            &mut self.data,
            &self.owner,
            false,
            0,
        )
    }
}

fn fixture() -> (Pubkey, [Account; 3]) {
    let program = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let config = Pubkey::find_program_address(&[b"config", authority.as_ref()], &program).0;
    let hook = Pubkey::new_unique();
    let project = Pubkey::find_program_address(&[b"project", hook.as_ref()], &program).0;
    let c = Config {
        authority,
        platform: Pubkey::new_unique(),
        bounty_source: 0,
        minimum: 1,
        maximum: 100,
    };
    let p = Project {
        config,
        hook,
        ..Project::default()
    };
    let mut config_data = vec![1];
    config_data.extend(borsh::to_vec(&c).unwrap());
    let mut project_data = vec![7];
    project_data.extend(borsh::to_vec(&p).unwrap());
    (
        program,
        [
            Account {
                key: authority,
                owner: solana_program::system_program::ID,
                lamports: 1,
                data: vec![],
                signer: true,
            },
            Account {
                key: config,
                owner: program,
                lamports: 1,
                data: config_data,
                signer: false,
            },
            Account {
                key: project,
                owner: program,
                lamports: 1,
                data: project_data,
                signer: false,
            },
        ],
    )
}

fn pause(program: &Pubkey, accounts: &mut [Account; 3]) -> Result<(), ProgramError> {
    let infos: Vec<_> = accounts.iter_mut().map(Account::info).collect();
    revenue::process(program, &infos, 7, &[1])
}

#[test]
fn pause_requires_the_config_authority_signature() {
    let (program, mut a) = fixture();
    a[0].signer = false;
    assert_eq!(
        pause(&program, &mut a),
        Err(ProgramError::MissingRequiredSignature)
    );
    a[0].signer = true;
    a[0].key = Pubkey::new_unique();
    assert!(pause(&program, &mut a).is_err());
}

#[test]
fn pause_rejects_foreign_owners_and_wrong_account_types() {
    for index in [1, 2] {
        let (program, mut a) = fixture();
        a[index].owner = Pubkey::new_unique();
        assert!(pause(&program, &mut a).is_err());
        a[index].owner = program;
        a[index].data[0] = 18;
        assert!(pause(&program, &mut a).is_err());
    }
}

#[test]
fn pause_rejects_substituted_config_and_project_addresses() {
    for index in [1, 2] {
        let (program, mut a) = fixture();
        a[index].key = Pubkey::new_unique();
        assert!(pause(&program, &mut a).is_err());
    }
}

#[test]
fn pause_rejects_a_valid_but_noncanonical_config_bump() {
    let (program, mut a) = fixture();
    let authority = a[0].key;
    let (_, canonical) = Pubkey::find_program_address(&[b"config", authority.as_ref()], &program);
    a[1].key = (0..canonical)
        .rev()
        .find_map(|bump| {
            Pubkey::create_program_address(&[b"config", authority.as_ref(), &[bump]], &program).ok()
        })
        .expect("fixture must have an alternative valid PDA bump");
    assert!(pause(&program, &mut a).is_err());
}

#[test]
fn pause_rejects_a_project_from_another_config() {
    let (program, mut a) = fixture();
    let mut project = Project::try_from_slice(&a[2].data[1..]).unwrap();
    project.config = Pubkey::new_unique();
    a[2].data = vec![7];
    a[2].data.extend(borsh::to_vec(&project).unwrap());
    assert!(pause(&program, &mut a).is_err());
}

#[test]
fn authorized_pause_invalidates_queued_policy_and_execution_nonces() {
    let (program, mut a) = fixture();
    pause(&program, &mut a).unwrap();
    let project = Project::try_from_slice(&a[2].data[1..]).unwrap();
    assert_eq!(
        (project.paused, project.policy_revision, project.nonce),
        (1, 1, 1)
    );
    assert_eq!(project.received, 0);
    assert_eq!(project.balances, [0; 5]);
}
