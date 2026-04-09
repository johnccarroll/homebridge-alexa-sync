import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';

export default (api: API) => {
  // Platform class will be added in Task 8
  api.registerPlatform(PLATFORM_NAME, class {} as any);
};
