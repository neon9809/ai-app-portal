import * as setup from './global-setup';

export default async function globalSetup(): Promise<void> {
  await setup.setup();
}
