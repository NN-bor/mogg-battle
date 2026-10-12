// Own relay (TURN) for the remote duel: "user:password@host" or "user:password@host:port".
// Needed where free relays don't get through (mobile internet in Russia): set up one with
// tools/turn-setup.sh on any small server and paste the line it prints here. Empty: free
// relays only. A ?turn=… in the address overrides this and travels along in invite links.
export const OWN_TURN = '';
