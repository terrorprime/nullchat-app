// The card under an invite link in a message: the server's picture, name, who is in it and a Join / Go to Server button.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useStore } from '../lib/state.js';
import { navigate } from '../lib/router.jsx';
import { toastError } from '../lib/toast.js';
import { lookupInvite, forgetInvite } from '../lib/invites.js';
import { Button, GuildIcon } from './ui.jsx';
import { Icon } from './icons.jsx';

const est = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');

export function InviteCards({ links }) {
  return <div className="invite-embeds">{links.map((l) => <InviteCard key={l.code} link={l} />)}</div>;
}

export function InviteCard({ link }) {
  const [res, setRes] = useState(null);          // null while loading
  const [joining, setJoining] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let live = true;
    lookupInvite(api, link.code).then((r) => { if (live) { setRes(r); setPaused(!!r.invite?.paused); } });
    return () => { live = false; };
  }, [link.code]);
  const guildId = res?.invite?.guild?.id;
  const member = useStore((s) => !!(guildId && s.guilds[guildId]));

  if (res?.status === 'error') return null;   // (the link is still in the message; a card that can't load is just left out)
  if (!res) return <div className="invite-embed loading" aria-hidden="true"><div className="ie-banner" /><div className="ie-body"><div className="ie-skel" /></div></div>;
  if (res.status === 'gone') {
    return (
      <div className="invite-embed gone" data-testid="invite-card" data-state="gone">
        <div className="ie-body ie-body-flat">
          <div className="ie-gone-icon"><Icon name="link" size={22} /></div>
          <div className="ie-name">Invite invalid</div>
          <div className="small muted">This invite is invalid or has expired. Ask for a new one.</div>
        </div>
      </div>
    );
  }

  const { invite } = res;
  const g = invite.guild;
  const join = async () => {
    setJoining(true);
    try {
      const r = await api.post(`/invites/${encodeURIComponent(link.code)}`, link.source ? { source: link.source } : undefined);
      forgetInvite(link.code);
      navigate(`/channels/${r.guildId}${r.channelId ? `/${r.channelId}` : ''}`);
    } catch (e) {
      if (e.code === 'invites_paused') setPaused(true);
      else { toastError(e); if (e.status === 404) forgetInvite(link.code); }
      setJoining(false);
    }
  };
  const backdrop = g.banner || g.icon;
  return (
    <div className="invite-embed" data-testid="invite-card" data-state={member ? 'member' : paused ? 'paused' : 'join'}>
      <div className="ie-banner" aria-hidden="true">
        {backdrop && <i className={g.banner ? 'ie-banner-img' : 'ie-banner-img blur'} style={{ backgroundImage: `url(${JSON.stringify(backdrop)})` }} />}
      </div>
      <div className="ie-body">
        <GuildIcon guild={g} size={56} className="ie-icon" />
        <div className="ie-name truncate" title={g.name}>{g.name}</div>
        <div className="ie-counts">
          <span><i className="dot online" />{invite.onlineCount} Online</span>
          <span><i className="dot" />{invite.memberCount} {invite.memberCount === 1 ? 'Member' : 'Members'}</span>
        </div>
        {g.createdAt > 0 && <div className="ie-est">Est. {est(g.createdAt)}</div>}
        {member ? (
          <Button variant="secondary" className="full" onClick={() => navigate(`/channels/${g.id}`)}>Go to Server</Button>
        ) : (
          <Button className="full" loading={joining} disabled={paused} onClick={join}>{paused ? 'Not taking new members' : 'Join'}</Button>
        )}
      </div>
    </div>
  );
}
