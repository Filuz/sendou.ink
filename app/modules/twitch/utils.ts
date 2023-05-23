import invariant from "tiny-invariant";

export const getTwitchEnvVars = () => {
  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
  invariant(TWITCH_CLIENT_ID, "Missing TWITCH_CLIENT_ID env var");
  invariant(TWITCH_CLIENT_SECRET, "Missing TWITCH_CLIENT_SECRET env var");

  return { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET };
};