export const BITWARDEN_BLOCK_NAMES = ["BWS_ACCESS_TOKEN", "BWS_SERVER_URL", "BWS_CONFIG_FILE", "BWS_PROFILE"] as const;

/** Every holder shadows the host's token and profile, including while signed out. */
export const bitwardenBlock = (address: string, token: string, configPath: string): Record<string, string> => ({
  BWS_ACCESS_TOKEN: token,
  BWS_SERVER_URL: address,
  BWS_CONFIG_FILE: configPath,
  BWS_PROFILE: "",
});
