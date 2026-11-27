import { type Observable, defer, of } from 'rxjs';
import { Injectable } from '@nestjs/common';
import { InMemoryWorkflowEntity } from '../../fixtures/in-memory-workflow-entity';

export enum OnboardingState {
  REGISTRATION = 'registration',
  EMAIL_VERIFICATION = 'email_verification',
  PROFILE_SETUP = 'profile_setup',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
  FAILED = 'failed',
}

export interface User {
  id: string;
  status: OnboardingState;
  email: string;
  emailVerified: boolean;
  profileComplete: boolean;
  userType?: 'individual' | 'business';
  profileData?: {
    firstName?: string;
    lastName?: string;
    companyName?: string;
  };
  registeredAt?: string;
  completedAt?: string;
}

/**
 * In-memory entity service for testing
 */
@Injectable()
export class UserEntityService extends InMemoryWorkflowEntity<User, 'status'> {
  constructor() {
    super('status');
  }

  create(): Observable<User> {
    return defer(() => {
      const user: User = {
        id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        status: OnboardingState.REGISTRATION,
        email: `user${Date.now()}@example.com`,
        emailVerified: false,
        profileComplete: false,
        registeredAt: new Date().toISOString(),
      };
      return of(this.save(user));
    });
  }
}
