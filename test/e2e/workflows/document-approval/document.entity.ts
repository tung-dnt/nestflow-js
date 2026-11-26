import { Injectable } from '@nestjs/common';
import { InMemoryWorkflowEntity } from '../../fixtures/in-memory-workflow-entity';

export enum DocumentState {
  DRAFT = 'draft',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  REVISION_REQUESTED = 'revision_requested',
  FAILED = 'failed',
}

export interface Document {
  id: string;
  status: DocumentState;
  title: string;
  content: string;
  documentType: 'contract' | 'policy' | 'report';
  approvers: string[];
  approvals: Array<{ approverId: string; approved: boolean; timestamp: string }>;
  revisionCount: number;
  createdAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
}

/**
 * In-memory entity service for testing
 */
@Injectable()
export class DocumentEntityService extends InMemoryWorkflowEntity<Document, 'status'> {
  constructor() {
    super('status');
  }

  async create(): Promise<Document> {
    const document: Document = {
      id: `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      status: DocumentState.DRAFT,
      title: '',
      content: '',
      documentType: 'contract',
      approvers: [],
      approvals: [],
      revisionCount: 0,
      createdAt: new Date().toISOString(),
    };
    return this.save(document);
  }
}
