import * as setup from './global-setup';

export default async function (): Promise<void> {
  await setup.teardown();
}
