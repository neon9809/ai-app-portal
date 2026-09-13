/** 领域内的小类型集合（A2/A4） */

export type VerifyChannel = 'email' | 'phone';
export type CodePurpose = 'register' | 'reset' | 'bind';

/** 注册开关三档（settings.REGISTRATION_MODE） */
export type RegistrationMode = 'closed' | 'open' | 'invite';
