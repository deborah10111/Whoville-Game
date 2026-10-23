import React, { useEffect, useRef, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../supabaseClient.js';

const DEFAULT_TEAMS = [
  { name: 'Red', color: '#c84242' },
  { name: 'Green', color: '#31966a' },
  { name: 'Gold', color: '#d2a63d' },
  { name: 'Silver', color: '#9aabba' },
  { name: 'Blue', color: '#4779bd' }
];

function errorMessage(error) {
  return error?.message || 'Something went wrong. Please try again.';
}

export default function MultiplayerApp() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [game, setGame] = useState(null);
  const [gameForUserId, setGameForUserId] = useState(null);
  const [gameReady, setGameReady] = useState(false);
  const gameRequestId = useRef(0);
  const [playerName, setPlayerName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [createMode, setCreateMode] = useState(false);
  const [teams, setTeams] = useState(DEFAULT_TEAMS.slice(0, 3));
  const [grinchCount, setGrinchCount] = useState(2);
  const [differentTeams, setDifferentTeams] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supabase) return undefined;
    let mounted = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (mounted) setSession(nextSession);
    });
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(errorMessage(sessionError));
      setSession(data?.session ?? null);
      setAuthReady(true);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function refreshGame() {
    if (!supabase) return;
    const userId = session?.user?.id;
    if (!userId) return;
    const requestId = ++gameRequestId.current;
    setGameReady(false);
    const { data, error: rpcError } = await supabase.rpc('get_my_game');
    if (requestId !== gameRequestId.current || session?.user?.id !== userId) return;
    if (rpcError) {
      setError(errorMessage(rpcError));
      setGame(null);
    } else {
      setGame(data || null);
      setError('');
    }
    setGameForUserId(userId);
    setGameReady(true);
  }

  useEffect(() => {
    gameRequestId.current += 1;
    if (session?.user) {
      setGame(null);
      setGameForUserId(null);
      refreshGame();
    }
    else {
      setGame(null);
      setGameForUserId(null);
      setGameReady(true);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user || !game?.room_id) return undefined;
    let active = true;
    const userId = session.user.id;
    const intervalId = window.setInterval(async () => {
      const requestId = ++gameRequestId.current;
      const { data, error: rpcError } = await supabase.rpc('get_my_game');
      if (!active || requestId !== gameRequestId.current || session?.user?.id !== userId) return;
      if (rpcError) setError(errorMessage(rpcError));
      else {
        setGame(data || null);
        setError('');
      }
      setGameForUserId(userId);
    }, 10000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [session?.user?.id, game?.room_id]);

  async function ensureGuestSession() {
    if (session?.user) return true;
    const { error: authError } = await supabase.auth.signInAnonymously();
    if (authError) {
      setError(`${errorMessage(authError)} Check that Anonymous Sign-Ins are enabled in Supabase Auth settings.`);
      return false;
    }
    return true;
  }

  function updateTeamCount(count) {
    setTeams(current => DEFAULT_TEAMS.slice(0, count).map((defaults, index) => current[index] || defaults));
  }

  function editTeam(index, field, value) {
    setTeams(current => current.map((team, teamIndex) => teamIndex === index ? { ...team, [field]: value } : team));
  }

  async function joinGame(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    if (!await ensureGuestSession()) {
      setBusy(false);
      return;
    }
    const { error: joinError } = await supabase.rpc('join_game', {
      p_join_code: joinCode.trim().toUpperCase(),
      p_display_name: playerName.trim()
    });
    setBusy(false);
    if (joinError) setError(errorMessage(joinError));
    else {
      setNotice('You joined the game. Your player view is ready.');
      await refreshGame();
    }
  }

  async function createGame(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    if (!await ensureGuestSession()) {
      setBusy(false);
      return;
    }
    const { data: room, error: createError } = await supabase.rpc('create_game', {
      p_team_names: teams.map(team => team.name.trim()),
      p_team_colors: teams.map(team => team.color),
      p_grinch_count: grinchCount,
      p_different_teams: differentTeams
    });
    if (createError) {
      setBusy(false);
      setError(errorMessage(createError));
      return;
    }
    const { error: joinError } = await supabase.rpc('join_game', {
      p_join_code: room.join_code,
      p_display_name: playerName.trim()
    });
    setBusy(false);
    if (joinError) setError(`Game created, but the host could not join: ${errorMessage(joinError)}`);
    else {
      setNotice(`Game created. Share this code with players: ${room.join_code}`);
      await refreshGame();
    }
  }

  async function hostAction(action, params = {}) {
    setBusy(true);
    setError('');
    const { error: actionError } = await supabase.rpc(action, { p_room_id: game.room_id, ...params });
    setBusy(false);
    if (actionError) setError(errorMessage(actionError));
    else {
      const notices = {
        assign_grinches: 'Secret roles were assigned by the server.',
        distribute_players: 'Players were evenly distributed across teams.',
        update_game_player: 'Player details saved.',
        remove_game_player: 'Player removed. Grinch roles were reset.',
        update_game_team: 'Team details saved.'
      };
      setNotice(notices[action] || 'Game settings saved.');
      await refreshGame();
    }
  }

  async function signOut() {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError(errorMessage(signOutError));
  }

  return (
    <main>
      <header>
        <div className="snow" aria-hidden="true">❄</div>
        <small>THE CHRISTMAS MILLIONAIRE</small>
        <h1>WELCOME TO WHOVILLE</h1>
        <p>Every Who has a secret. Your game view is private to your account.</p>
      </header>
      {error && <p className="storage-warning" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      {!isSupabaseConfigured ? <ConfigurationNotice /> : !authReady ? (
        <section className="panel access-panel"><p>Connecting securely to Whoville…</p></section>
      ) : session && (!gameReady || gameForUserId !== session.user.id) ? (
        <section className="panel access-panel"><p>Loading your player view…</p></section>
      ) : session && game ? (
        <PlayerDashboard
          game={game}
          busy={busy}
          onRefresh={refreshGame}
          onHostAction={hostAction}
          onSignOut={signOut}
        />
      ) : (
        <section className="panel access-panel">
          <div className="account-row">
            <div>
              <p className="eyebrow">PLAYER ACCESS</p>
              <strong>{session ? 'Guest session active' : 'No account needed'}</strong>
              <p className="subtle">Your player identity stays in this browser. Use a separate device or browser for each player.</p>
            </div>
            {session && <button className="button-secondary" onClick={signOut}>Sign out</button>}
          </div>
          <div className="join-create-tabs">
            <button className={!createMode ? 'active' : ''} onClick={() => setCreateMode(false)}>Join a game</button>
            <button className={createMode ? 'active' : ''} onClick={() => setCreateMode(true)}>Create a game</button>
          </div>
          {createMode ? (
            <form className="access-form" onSubmit={createGame}>
              <h2>Start a Whoville game</h2>
              <label>Your player name
                <input required maxLength={40} value={playerName} onChange={event => setPlayerName(event.target.value)} />
              </label>
              <label>Number of teams
                <select value={teams.length} onChange={event => updateTeamCount(Number(event.target.value))}>
                  {[2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}
                </select>
              </label>
              <div className="team-editor-grid">
                {teams.map((team, index) => (
                  <div className="team-editor" key={index}>
                    <label className="visually-hidden" htmlFor={`new-team-name-${index}`}>Team {index + 1} name</label>
                    <input id={`new-team-name-${index}`} required maxLength={24} value={team.name} onChange={event => editTeam(index, 'name', event.target.value)} />
                    <label className="visually-hidden" htmlFor={`new-team-color-${index}`}>Team {team.name} color</label>
                    <input id={`new-team-color-${index}`} className="color-input" type="color" value={team.color} onChange={event => editTeam(index, 'color', event.target.value)} />
                  </div>
                ))}
              </div>
              <label>Number of Grinches
                <select value={grinchCount} onChange={event => setGrinchCount(Number(event.target.value))}>
                  {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}
                </select>
              </label>
              <label className="check-option">
                <input type="checkbox" checked={differentTeams} onChange={event => setDifferentTeams(event.target.checked)} />
                <span><strong>Put Grinches on different teams</strong><small>Players will be distributed evenly when they join.</small></span>
              </label>
              <button disabled={busy}>{busy ? 'Creating game…' : 'Create game'}</button>
            </form>
          ) : (
            <form className="access-form" onSubmit={joinGame}>
              <h2>Join a Whoville game</h2>
              <label>Game code
                <input required maxLength={12} autoCapitalize="characters" value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} />
              </label>
              <label>Your player name
                <input required maxLength={40} value={playerName} onChange={event => setPlayerName(event.target.value)} />
              </label>
              <button disabled={busy}>{busy ? 'Joining…' : 'Join game'}</button>
            </form>
          )}
        </section>
      )}
      <footer>WHOVILLE GAME HQ · Guest player access · Private roles enforced by the server</footer>
    </main>
  );
}

function ConfigurationNotice() {
  return (
    <section className="panel access-panel">
      <h2>Secure game access needs setup</h2>
      <p>This app is configured for private player accounts, but it is not connected to a Supabase project yet.</p>
      <ol className="setup-instructions">
        <li>Create a Supabase project on the Free plan and enable Anonymous Sign-Ins in Authentication settings.</li>
        <li>Run the SQL in <code>supabase/schema.sql</code> in the Supabase SQL Editor.</li>
        <li>Copy <code>.env.example</code> to <code>.env.local</code> and add the project URL and public anon key.</li>
        <li>Restart Vite. The secret service-role key must never be placed in the browser app.</li>
      </ol>
      <p className="security-note"><strong>Free friend access.</strong> The project URL and public anon key are included at no charge on Supabase Free. Friends join with guest sessions, a display name, and the room code—no email service is needed. Each guest session sees only its own role, enforced by the database.</p>
    </section>
  );
}

function PlayerDashboard({ game, busy, onRefresh, onHostAction, onSignOut }) {
  const isGrinch = game.role === 'grinch';
  const grinchNames = game.grinch_names || [];
  return (
    <>
      <section className="player-welcome">
        <div>
          <p className="eyebrow">{game.is_host ? 'GAME HOST' : 'PLAYER'}</p>
          <h2>Welcome, {game.player_name}</h2>
          <p>Share code <strong className="join-code">{game.join_code}</strong> with players who should join this game.</p>
        </div>
        <div className="player-actions">
          <button className="button-secondary" onClick={onRefresh}>Refresh</button>
          <button className="button-secondary" onClick={onSignOut}>Sign out</button>
        </div>
      </section>
      <section className="role-card" aria-live="polite">
        <span className={isGrinch ? 'role-mark grinch-mark' : 'role-mark who-mark'} aria-hidden="true">{isGrinch ? '🎭' : '🎄'}</span>
        <div>
          <p className="eyebrow">YOUR PRIVATE ROLE</p>
          <h3>{isGrinch ? 'GRINCH' : 'WHO'}</h3>
          {isGrinch && (
            <>
              <p className="mission-message">{game.mission}</p>
              {grinchNames.length > 0 && <p className="grinch-allies"><strong>Your fellow Grinches:</strong> {grinchNames.join(', ')}</p>}
            </>
          )}
        </div>
      </section>
      <h2>Whoville Treasury</h2>
      <section className="scores">
        {(game.teams || []).map(team => (
          <article key={team.id} style={{ '--team-color': team.color }}>
            <small>TEAM {team.name}</small>
            <strong>${Number(team.cash).toLocaleString()}</strong>
          </article>
        ))}
      </section>
      <section className="panel scoreboard-note">
        <h3>Town Square</h3>
        <p>The team prize pool and scoreboard are shared with players in this game. Private roles are not shown here.</p>
      </section>
      {game.is_host && (
        <section className="panel host-panel">
          <h3>Host controls</h3>
          <p>Players in this room: {(game.players || []).length}. Roster is visible to the host only; secret roles are not included.</p>
          {(game.players || []).length > 0 && (
            <ul className="host-roster">
              {game.players.map(player => {
                const isHostPlayer = player.id === game.player_id;
                return (
                  <PlayerEditor
                    key={player.id}
                    player={player}
                    teams={game.teams}
                    busy={busy}
                    isHostPlayer={isHostPlayer}
                    onSave={(displayName, teamId) => onHostAction('update_game_player', {
                      p_player_id: player.id,
                      p_display_name: displayName,
                      p_team_id: teamId
                    })}
                    onRemove={() => onHostAction('remove_game_player', { p_player_id: player.id })}
                  />
                );
              })}
            </ul>
          )}
          <h3>Customize teams</h3>
          <ul className="host-roster team-roster">
            {game.teams.map(team => (
              <TeamEditor
                key={team.id}
                team={team}
                busy={busy}
                onSave={(name, color) => onHostAction('update_game_team', {
                  p_team_id: team.id,
                  p_name: name,
                  p_color: color
                })}
              />
            ))}
          </ul>
          <div className="host-actions">
            <button className="button-secondary" disabled={busy || !(game.players || []).length} onClick={() => onHostAction('distribute_players')}>🎲 Distribute players</button>
            <button disabled={busy || (game.players || []).length < game.grinch_count} onClick={() => onHostAction('assign_grinches')}>🎭 Assign Grinches</button>
          </div>
          <p>Changing player teams, removing players, or redistributing the roster resets role assignments. Assign Grinches again afterward.</p>
        </section>
      )}
    </>
  );
}

function PlayerEditor({ player, teams, busy, isHostPlayer, onSave, onRemove }) {
  const [name, setName] = useState(player.display_name);
  const [teamId, setTeamId] = useState(player.team_id);
  return (
    <li className="host-player-editor">
      <label className="visually-hidden" htmlFor={`roster-name-${player.id}`}>Name for {player.display_name}</label>
      <input
        id={`roster-name-${player.id}`}
        value={name}
        maxLength={40}
        onChange={event => setName(event.target.value)}
      />
      <label className="visually-hidden" htmlFor={`roster-team-${player.id}`}>Team for {player.display_name}</label>
      <select id={`roster-team-${player.id}`} value={teamId} onChange={event => setTeamId(event.target.value)}>
        {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>
      <button className="button-secondary" disabled={busy || !name.trim()} onClick={() => onSave(name.trim(), teamId)}>Save</button>
      {!isHostPlayer && <button className="remove-button" disabled={busy} onClick={onRemove}>Remove</button>}
    </li>
  );
}

function TeamEditor({ team, busy, onSave }) {
  const [name, setName] = useState(team.name);
  const [color, setColor] = useState(team.color);
  return (
    <li className="host-team-editor">
      <label className="visually-hidden" htmlFor={`host-team-name-${team.id}`}>Team name</label>
      <input id={`host-team-name-${team.id}`} value={name} maxLength={24} onChange={event => setName(event.target.value)} />
      <label className="visually-hidden" htmlFor={`host-team-color-${team.id}`}>Team color</label>
      <input id={`host-team-color-${team.id}`} className="color-input" type="color" value={color} onChange={event => setColor(event.target.value)} />
      <button className="button-secondary" disabled={busy || !name.trim()} onClick={() => onSave(name.trim(), color)}>Save</button>
    </li>
  );
}
