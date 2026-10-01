/** Doppler's token and CLI isolation, including the higher-precedence deprecated aliases. */
export const dopplerBlock = (address: string, token: string, directory: string): Record<string, string> => ({
  DOPPLER_TOKEN: token,
  DOPPLER_API_HOST: address,
  DOPPLER_CONFIG_DIR: directory,
  DOPPLER_ENABLE_VERSION_CHECK: "false",
  DOPPLER_VERIFY_TLS: "true",
  DOPPLER_PROJECT: "",
  DOPPLER_CONFIG: "",
  ENCLAVE_PROJECT: "",
  ENCLAVE_CONFIG: "",
});
export const DOPPLER_BLOCK_NAMES = Object.keys(dopplerBlock("", "", ""));
