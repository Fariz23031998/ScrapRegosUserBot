declare module 'node-windows' {
  interface ServiceEnvVar {
    name: string;
    value: string;
  }

  interface ServiceOptions {
    name: string;
    description?: string;
    script: string;
    workingDirectory?: string;
    logpath?: string;
    grow?: number;
    wait?: number;
    maxRestarts?: number;
    abortOnError?: boolean;
    env?: ServiceEnvVar[];
  }

  interface ServiceLogOn {
    domain?: string;
    account?: string;
    password?: string;
  }

  class Service {
    constructor(config: ServiceOptions);
    logOnAs: ServiceLogOn;
    on(event: 'install' | 'alreadyinstalled' | 'alreadyuninstalled' | 'uninstall' | 'start' | 'stop' | 'error', listener: (error?: Error) => void): void;
    install(): void;
    uninstall(): void;
    start(): void;
  }
}
