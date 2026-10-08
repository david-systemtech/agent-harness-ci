import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * How to set up the host-side updater, as Your machines' How to set it up
 * shows it to a container no updater has polled yet (setup-copy.md §5.4;
 * docs/host-updater.md, "Installing it"; #1883): the folder the release's
 * two files go in, the commands to run there, each to copy, and what comes
 * after. Every renderer says the same.
 */
export interface HostUpdaterSetup {
  readonly heading: string;
  readonly intro: string;
  /** Each command, under what it does. */
  readonly commands: readonly { readonly label: string; readonly text: string }[];
  readonly after: string;
}

export const HOST_UPDATER_SETUP: HostUpdaterSetup = {
  heading: "Set up the updater on the host computer",
  intro: `On the computer that runs Docker, put compose.yaml and host-updater.sh from the same ${PRODUCT_NAME} release in one folder, such as /opt/agent-harness. Then, in that folder:`,
  commands: [
    { label: `Start ${PRODUCT_NAME} and make the updater runnable`, text: "cd /opt/agent-harness && docker compose up -d && chmod +x host-updater.sh" },
    {
      label: "Run the updater every five minutes: add this line with crontab -e, as the user that runs docker",
      text: "*/5 * * * * /opt/agent-harness/host-updater.sh >>/opt/agent-harness/host-updater.log 2>&1",
    },
  ],
  after: "Once it has run, choose Check again. A systemd timer works too: docs/host-updater.md has both.",
};
