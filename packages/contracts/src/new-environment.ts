/**
 * The variables a new environment's name and release channel come from
 * where no flag gives them (#846): `serve` reads them, and only the start
 * that creates the environment uses them, so a later start keeps the name
 * and channel it has. The published compose file passes both into the
 * container from compose's own variables, and Add a machine's container
 * snippet sets them on its `docker compose up -d` line, as the install
 * lines pass `--channel` and `--name` to the install scripts.
 */

/** The new environment's name; blank or unset, the hostname's first label. */
export const NEW_ENVIRONMENT_NAME_VARIABLE = "AGENT_HARNESS_NAME";

/** The new environment's release channel, `stable` or `beta`; blank or unset, the setting's preset. */
export const NEW_ENVIRONMENT_CHANNEL_VARIABLE = "AGENT_HARNESS_CHANNEL";
