export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      achievement_audit: {
        Row: {
          achievement_id: string | null
          action: string
          created_at: string
          detail: Json
          engine_version: string
          guest_id: string
          id: string
          reason: string
          source_event_id: string | null
          source_match_id: string | null
        }
        Insert: {
          achievement_id?: string | null
          action: string
          created_at?: string
          detail?: Json
          engine_version?: string
          guest_id: string
          id?: string
          reason?: string
          source_event_id?: string | null
          source_match_id?: string | null
        }
        Update: {
          achievement_id?: string | null
          action?: string
          created_at?: string
          detail?: Json
          engine_version?: string
          guest_id?: string
          id?: string
          reason?: string
          source_event_id?: string | null
          source_match_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "achievement_audit_achievement_id_fkey"
            columns: ["achievement_id"]
            isOneToOne: false
            referencedRelation: "ustad_achievements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "achievement_audit_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      api_configs: {
        Row: {
          config: Json
          created_at: string
          guest_id: string
          healthy: boolean | null
          id: string
          last_tested_at: string | null
          latency_ms: number | null
          models: Json
          provider: string
          status: string
          status_detail: string | null
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          guest_id: string
          healthy?: boolean | null
          id?: string
          last_tested_at?: string | null
          latency_ms?: number | null
          models?: Json
          provider: string
          status?: string
          status_detail?: string | null
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          guest_id?: string
          healthy?: boolean | null
          id?: string
          last_tested_at?: string | null
          latency_ms?: number | null
          models?: Json
          provider?: string
          status?: string
          status_detail?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_configs_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      attachments: {
        Row: {
          conversation_id: string | null
          created_at: string
          data: string
          extracted_text: string | null
          guest_id: string
          id: string
          kind: string
          mime: string
          name: string
          size: number
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          data?: string
          extracted_text?: string | null
          guest_id: string
          id?: string
          kind?: string
          mime?: string
          name?: string
          size?: number
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          data?: string
          extracted_text?: string | null
          guest_id?: string
          id?: string
          kind?: string
          mime?: string
          name?: string
          size?: number
        }
        Relationships: [
          {
            foreignKeyName: "attachments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attachments_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      certificate_audit: {
        Row: {
          action: string
          certificate_id: string
          created_at: string
          detail: Json
          engine_version: string
          guest_id: string | null
          id: string
          reason: string
        }
        Insert: {
          action: string
          certificate_id: string
          created_at?: string
          detail?: Json
          engine_version?: string
          guest_id?: string | null
          id?: string
          reason?: string
        }
        Update: {
          action?: string
          certificate_id?: string
          created_at?: string
          detail?: Json
          engine_version?: string
          guest_id?: string | null
          id?: string
          reason?: string
        }
        Relationships: []
      }
      certificate_templates: {
        Row: {
          active: boolean
          certificate_type: string
          code: string
          created_at: string
          event_id: string | null
          id: string
          subtitle: string
          theme: Json
          title: string
          version: number
        }
        Insert: {
          active?: boolean
          certificate_type: string
          code: string
          created_at?: string
          event_id?: string | null
          id?: string
          subtitle?: string
          theme?: Json
          title: string
          version?: number
        }
        Update: {
          active?: boolean
          certificate_type?: string
          code?: string
          created_at?: string
          event_id?: string | null
          id?: string
          subtitle?: string
          theme?: Json
          title?: string
          version?: number
        }
        Relationships: []
      }
      conversations: {
        Row: {
          created_at: string
          guest_id: string
          id: string
          pinned: boolean
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          guest_id: string
          id?: string
          pinned?: boolean
          title?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          guest_id?: string
          id?: string
          pinned?: boolean
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_attempt_questions: {
        Row: {
          answered_at: string | null
          answered_index: number | null
          attempt_id: string
          category: string
          correct_index: number
          created_at: string
          difficulty: string
          explanation: string
          fifty_removed: Json | null
          guest_id: string
          hint: string
          hint_shown: boolean
          id: string
          options: Json
          question: string
          question_number: number
          was_correct: boolean | null
          was_skipped: boolean
        }
        Insert: {
          answered_at?: string | null
          answered_index?: number | null
          attempt_id: string
          category?: string
          correct_index: number
          created_at?: string
          difficulty?: string
          explanation?: string
          fifty_removed?: Json | null
          guest_id: string
          hint?: string
          hint_shown?: boolean
          id?: string
          options: Json
          question: string
          question_number: number
          was_correct?: boolean | null
          was_skipped?: boolean
        }
        Update: {
          answered_at?: string | null
          answered_index?: number | null
          attempt_id?: string
          category?: string
          correct_index?: number
          created_at?: string
          difficulty?: string
          explanation?: string
          fifty_removed?: Json | null
          guest_id?: string
          hint?: string
          hint_shown?: boolean
          id?: string
          options?: Json
          question?: string
          question_number?: number
          was_correct?: boolean | null
          was_skipped?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_attempt_questions_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "crorepati_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_attempt_questions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_attempts: {
        Row: {
          answer_timer_starts_at: string | null
          cleared_questions: number
          coin_reward: number
          current_question: number
          deadline_at: string | null
          ended_at: string | null
          entry_id: string | null
          event_id: string
          fifty_fifty_used: boolean
          game_state: string
          guest_id: string
          hint_used: boolean
          id: string
          language: string | null
          meta: Json
          presented_at: string | null
          result: string | null
          skip_used: boolean
          skipped_questions: number
          started_at: string
          status: string
          wrong_question: number | null
        }
        Insert: {
          answer_timer_starts_at?: string | null
          cleared_questions?: number
          coin_reward?: number
          current_question?: number
          deadline_at?: string | null
          ended_at?: string | null
          entry_id?: string | null
          event_id: string
          fifty_fifty_used?: boolean
          game_state?: string
          guest_id: string
          hint_used?: boolean
          id?: string
          language?: string | null
          meta?: Json
          presented_at?: string | null
          result?: string | null
          skip_used?: boolean
          skipped_questions?: number
          started_at?: string
          status?: string
          wrong_question?: number | null
        }
        Update: {
          answer_timer_starts_at?: string | null
          cleared_questions?: number
          coin_reward?: number
          current_question?: number
          deadline_at?: string | null
          ended_at?: string | null
          entry_id?: string | null
          event_id?: string
          fifty_fifty_used?: boolean
          game_state?: string
          guest_id?: string
          hint_used?: boolean
          id?: string
          language?: string | null
          meta?: Json
          presented_at?: string | null
          result?: string | null
          skip_used?: boolean
          skipped_questions?: number
          started_at?: string
          status?: string
          wrong_question?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_attempts_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "crorepati_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_attempts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "crorepati_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_attempts_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_entries: {
        Row: {
          attempt_id: string | null
          created_at: string
          currency: string
          entry_type: string
          event_id: string
          free_entry_used: boolean
          guest_id: string
          id: string
          idempotency_key: string | null
          ledger_ref: string | null
          occurrence_id: string | null
          paid_entry: boolean
          price: number
          status: string
        }
        Insert: {
          attempt_id?: string | null
          created_at?: string
          currency?: string
          entry_type: string
          event_id: string
          free_entry_used?: boolean
          guest_id: string
          id?: string
          idempotency_key?: string | null
          ledger_ref?: string | null
          occurrence_id?: string | null
          paid_entry?: boolean
          price?: number
          status?: string
        }
        Update: {
          attempt_id?: string | null
          created_at?: string
          currency?: string
          entry_type?: string
          event_id?: string
          free_entry_used?: boolean
          guest_id?: string
          id?: string
          idempotency_key?: string | null
          ledger_ref?: string | null
          occurrence_id?: string | null
          paid_entry?: boolean
          price?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_entries_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "crorepati_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_entries_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "crorepati_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_entries_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_entries_occurrence_id_fkey"
            columns: ["occurrence_id"]
            isOneToOne: false
            referencedRelation: "crorepati_event_occurrences"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_entry_state: {
        Row: {
          event_id: string
          free_entries: number
          free_entries_used: number
          guest_id: string
          last_played_at: string | null
          last_recovered_at: string | null
          missed_streak: number
          paid_entries_used: number
          recovery_count: number
          updated_at: string
          zero_notified: boolean
        }
        Insert: {
          event_id: string
          free_entries?: number
          free_entries_used?: number
          guest_id: string
          last_played_at?: string | null
          last_recovered_at?: string | null
          missed_streak?: number
          paid_entries_used?: number
          recovery_count?: number
          updated_at?: string
          zero_notified?: boolean
        }
        Update: {
          event_id?: string
          free_entries?: number
          free_entries_used?: number
          guest_id?: string
          last_played_at?: string | null
          last_recovered_at?: string | null
          missed_streak?: number
          paid_entries_used?: number
          recovery_count?: number
          updated_at?: string
          zero_notified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_entry_state_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "crorepati_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_entry_state_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: true
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_event_occurrences: {
        Row: {
          closed_at: string
          created_at: string
          event_id: string
          id: string
          opened_at: string
          status: string
        }
        Insert: {
          closed_at: string
          created_at?: string
          event_id: string
          id?: string
          opened_at: string
          status?: string
        }
        Update: {
          closed_at?: string
          created_at?: string
          event_id?: string
          id?: string
          opened_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_event_occurrences_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "crorepati_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_events: {
        Row: {
          active: boolean
          answer_timer_seconds: number
          code: string
          config: Json
          created_at: string
          entry_timezone: string
          free_entries_grant: number
          id: string
          max_free_entries: number
          missed_threshold: number
          mode: string
          open_hour: number
          open_minute: number
          paid_entry_coin_cost: number
          paid_entry_enabled: boolean
          pre_timer_seconds: number
          question_count: number
          schedule_weekdays: Json
          title: string
          window_minutes: number
        }
        Insert: {
          active?: boolean
          answer_timer_seconds?: number
          code: string
          config?: Json
          created_at?: string
          entry_timezone?: string
          free_entries_grant?: number
          id?: string
          max_free_entries?: number
          missed_threshold?: number
          mode?: string
          open_hour?: number
          open_minute?: number
          paid_entry_coin_cost?: number
          paid_entry_enabled?: boolean
          pre_timer_seconds?: number
          question_count?: number
          schedule_weekdays?: Json
          title?: string
          window_minutes?: number
        }
        Update: {
          active?: boolean
          answer_timer_seconds?: number
          code?: string
          config?: Json
          created_at?: string
          entry_timezone?: string
          free_entries_grant?: number
          id?: string
          max_free_entries?: number
          missed_threshold?: number
          mode?: string
          open_hour?: number
          open_minute?: number
          paid_entry_coin_cost?: number
          paid_entry_enabled?: boolean
          pre_timer_seconds?: number
          question_count?: number
          schedule_weekdays?: Json
          title?: string
          window_minutes?: number
        }
        Relationships: []
      }
      crorepati_participation: {
        Row: {
          attempt_id: string | null
          closed_at: string
          counted: boolean
          created_at: string
          eligible: boolean
          event_id: string
          guest_id: string
          occurrence_id: string
          opened_at: string
          played: boolean
        }
        Insert: {
          attempt_id?: string | null
          closed_at: string
          counted?: boolean
          created_at?: string
          eligible?: boolean
          event_id: string
          guest_id: string
          occurrence_id: string
          opened_at: string
          played?: boolean
        }
        Update: {
          attempt_id?: string | null
          closed_at?: string
          counted?: boolean
          created_at?: string
          eligible?: boolean
          event_id?: string
          guest_id?: string
          occurrence_id?: string
          opened_at?: string
          played?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_participation_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "crorepati_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_participation_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "crorepati_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_participation_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crorepati_participation_occurrence_id_fkey"
            columns: ["occurrence_id"]
            isOneToOne: false
            referencedRelation: "crorepati_event_occurrences"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_rewards: {
        Row: {
          coins: number
          event_id: string
          question_number: number
        }
        Insert: {
          coins?: number
          event_id: string
          question_number: number
        }
        Update: {
          coins?: number
          event_id?: string
          question_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_rewards_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "crorepati_events"
            referencedColumns: ["id"]
          },
        ]
      }
      crorepati_served_questions: {
        Row: {
          guest_id: string
          last_served_at: string
          question_hash: string
        }
        Insert: {
          guest_id: string
          last_served_at?: string
          question_hash: string
        }
        Update: {
          guest_id?: string
          last_served_at?: string
          question_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "crorepati_served_questions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      curriculum_boards: {
        Row: {
          aliases: Json
          board_id: string
          created_at: string
          name: string
          session_start_month: number
        }
        Insert: {
          aliases?: Json
          board_id: string
          created_at?: string
          name: string
          session_start_month: number
        }
        Update: {
          aliases?: Json
          board_id?: string
          created_at?: string
          name?: string
          session_start_month?: number
        }
        Relationships: []
      }
      curriculum_books: {
        Row: {
          academic_session: string
          board_id: string
          book_id: string
          book_name: string
          book_part: string | null
          created_at: string
          edition: string | null
          klass: number
          last_verified_at: string | null
          record_status: string
          source_reference: string | null
          subject_id: string
          verification_status: string
        }
        Insert: {
          academic_session: string
          board_id: string
          book_id: string
          book_name: string
          book_part?: string | null
          created_at?: string
          edition?: string | null
          klass: number
          last_verified_at?: string | null
          record_status?: string
          source_reference?: string | null
          subject_id: string
          verification_status?: string
        }
        Update: {
          academic_session?: string
          board_id?: string
          book_id?: string
          book_name?: string
          book_part?: string | null
          created_at?: string
          edition?: string | null
          klass?: number
          last_verified_at?: string | null
          record_status?: string
          source_reference?: string | null
          subject_id?: string
          verification_status?: string
        }
        Relationships: []
      }
      curriculum_chapters: {
        Row: {
          book_id: string
          chapter_id: string
          chapter_name: string
          chapter_number: number
          chapter_order: number
          created_at: string
          last_verified_at: string | null
          source_reference: string | null
          verification_status: string
        }
        Insert: {
          book_id: string
          chapter_id: string
          chapter_name: string
          chapter_number: number
          chapter_order: number
          created_at?: string
          last_verified_at?: string | null
          source_reference?: string | null
          verification_status?: string
        }
        Update: {
          book_id?: string
          chapter_id?: string
          chapter_name?: string
          chapter_number?: number
          chapter_order?: number
          created_at?: string
          last_verified_at?: string | null
          source_reference?: string | null
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "curriculum_chapters_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "curriculum_books"
            referencedColumns: ["book_id"]
          },
        ]
      }
      curriculum_chapters_detail: {
        Row: {
          book_id: string
          chapter_id: string
          chapter_name: string
          chapter_number: number
          concepts_count: number
          created_at: string
          examples_count: number
          extracted_at: string
          formulas_count: number
          questions_count: number
          record_status: string
          section_order: number[]
          source_reference: string | null
          summary: string | null
          topics_count: number
          verification_status: string
          version: string
        }
        Insert: {
          book_id: string
          chapter_id: string
          chapter_name: string
          chapter_number: number
          concepts_count?: number
          created_at?: string
          examples_count?: number
          extracted_at?: string
          formulas_count?: number
          questions_count?: number
          record_status?: string
          section_order?: number[]
          source_reference?: string | null
          summary?: string | null
          topics_count?: number
          verification_status?: string
          version?: string
        }
        Update: {
          book_id?: string
          chapter_id?: string
          chapter_name?: string
          chapter_number?: number
          concepts_count?: number
          created_at?: string
          examples_count?: number
          extracted_at?: string
          formulas_count?: number
          questions_count?: number
          record_status?: string
          section_order?: number[]
          source_reference?: string | null
          summary?: string | null
          topics_count?: number
          verification_status?: string
          version?: string
        }
        Relationships: []
      }
      curriculum_concepts: {
        Row: {
          book_id: string
          chapter_id: string
          concept_id: string
          created_at: string
          kind: string
          math_raw: string | null
          source_location: string | null
          text: string
          topic_id: string | null
          variables: string[] | null
        }
        Insert: {
          book_id: string
          chapter_id: string
          concept_id: string
          created_at?: string
          kind?: string
          math_raw?: string | null
          source_location?: string | null
          text: string
          topic_id?: string | null
          variables?: string[] | null
        }
        Update: {
          book_id?: string
          chapter_id?: string
          concept_id?: string
          created_at?: string
          kind?: string
          math_raw?: string | null
          source_location?: string | null
          text?: string
          topic_id?: string | null
          variables?: string[] | null
        }
        Relationships: []
      }
      curriculum_questions: {
        Row: {
          answer_reference: string | null
          book_id: string
          chapter_id: string
          created_at: string
          diagram_required: boolean
          question_id: string
          question_type: string
          related_concept: string | null
          related_formula: string | null
          section_id: string | null
          source_location: string | null
          text: string
        }
        Insert: {
          answer_reference?: string | null
          book_id: string
          chapter_id: string
          created_at?: string
          diagram_required?: boolean
          question_id: string
          question_type?: string
          related_concept?: string | null
          related_formula?: string | null
          section_id?: string | null
          source_location?: string | null
          text: string
        }
        Update: {
          answer_reference?: string | null
          book_id?: string
          chapter_id?: string
          created_at?: string
          diagram_required?: boolean
          question_id?: string
          question_type?: string
          related_concept?: string | null
          related_formula?: string | null
          section_id?: string | null
          source_location?: string | null
          text?: string
        }
        Relationships: []
      }
      curriculum_sections: {
        Row: {
          book_id: string
          chapter_id: string
          created_at: string
          order: number
          section_id: string
          title: string
        }
        Insert: {
          book_id: string
          chapter_id: string
          created_at?: string
          order?: number
          section_id: string
          title: string
        }
        Update: {
          book_id?: string
          chapter_id?: string
          created_at?: string
          order?: number
          section_id?: string
          title?: string
        }
        Relationships: []
      }
      curriculum_sessions: {
        Row: {
          board_id: string
          created_at: string
          end_year: number
          label: string
          session_id: string
          start_year: number
        }
        Insert: {
          board_id: string
          created_at?: string
          end_year: number
          label: string
          session_id: string
          start_year: number
        }
        Update: {
          board_id?: string
          created_at?: string
          end_year?: number
          label?: string
          session_id?: string
          start_year?: number
        }
        Relationships: [
          {
            foreignKeyName: "curriculum_sessions_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "curriculum_boards"
            referencedColumns: ["board_id"]
          },
        ]
      }
      curriculum_subjects: {
        Row: {
          board_id: string
          created_at: string
          klass: number
          name: string
          subject_id: string
        }
        Insert: {
          board_id: string
          created_at?: string
          klass: number
          name: string
          subject_id: string
        }
        Update: {
          board_id?: string
          created_at?: string
          klass?: number
          name?: string
          subject_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "curriculum_subjects_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "curriculum_boards"
            referencedColumns: ["board_id"]
          },
        ]
      }
      curriculum_topics: {
        Row: {
          book_id: string
          chapter_id: string
          content: string | null
          created_at: string
          order: number
          section_id: string | null
          title: string
          topic_id: string
        }
        Insert: {
          book_id: string
          chapter_id: string
          content?: string | null
          created_at?: string
          order?: number
          section_id?: string | null
          title: string
          topic_id: string
        }
        Update: {
          book_id?: string
          chapter_id?: string
          content?: string | null
          created_at?: string
          order?: number
          section_id?: string | null
          title?: string
          topic_id?: string
        }
        Relationships: []
      }
      curriculum_verifications: {
        Row: {
          academic_session: string
          board_id: string
          book_id: string
          id: number
          klass: number
          record_status: string
          source_reference: string | null
          subject_id: string
          verification_status: string
          verified_at: string
        }
        Insert: {
          academic_session: string
          board_id: string
          book_id: string
          id?: never
          klass: number
          record_status: string
          source_reference?: string | null
          subject_id: string
          verification_status: string
          verified_at?: string
        }
        Update: {
          academic_session?: string
          board_id?: string
          book_id?: string
          id?: never
          klass?: number
          record_status?: string
          source_reference?: string | null
          subject_id?: string
          verification_status?: string
          verified_at?: string
        }
        Relationships: []
      }
      exam_batches: {
        Row: {
          board: string | null
          created_at: string
          difficulty: string
          district: string | null
          duration_minutes: number
          father_name: string | null
          guest_id: string
          id: string
          klass: string
          language: string
          mother_name: string | null
          negative_marking: number
          question_type: string
          status: string
          student_name: string
          subjects: Json
          timezone: string
          title: string
          updated_at: string
          village: string | null
        }
        Insert: {
          board?: string | null
          created_at?: string
          difficulty?: string
          district?: string | null
          duration_minutes?: number
          father_name?: string | null
          guest_id: string
          id?: string
          klass?: string
          language?: string
          mother_name?: string | null
          negative_marking?: number
          question_type?: string
          status?: string
          student_name?: string
          subjects?: Json
          timezone?: string
          title?: string
          updated_at?: string
          village?: string | null
        }
        Update: {
          board?: string | null
          created_at?: string
          difficulty?: string
          district?: string | null
          duration_minutes?: number
          father_name?: string | null
          guest_id?: string
          id?: string
          klass?: string
          language?: string
          mother_name?: string | null
          negative_marking?: number
          question_type?: string
          status?: string
          student_name?: string
          subjects?: Json
          timezone?: string
          title?: string
          updated_at?: string
          village?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_batches_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_combined_results: {
        Row: {
          batch_id: string | null
          created_at: string
          division: string
          exam_ids: Json
          guest_id: string
          id: string
          partial: boolean
          percentage: number
          student: Json
          subjects: Json
          title: string
          total_max: number
          total_obtained: number
          updated_at: string
        }
        Insert: {
          batch_id?: string | null
          created_at?: string
          division?: string
          exam_ids?: Json
          guest_id: string
          id?: string
          partial?: boolean
          percentage?: number
          student?: Json
          subjects?: Json
          title?: string
          total_max?: number
          total_obtained?: number
          updated_at?: string
        }
        Update: {
          batch_id?: string | null
          created_at?: string
          division?: string
          exam_ids?: Json
          guest_id?: string
          id?: string
          partial?: boolean
          percentage?: number
          student?: Json
          subjects?: Json
          title?: string
          total_max?: number
          total_obtained?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_combined_results_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "exam_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_combined_results_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_results: {
        Row: {
          answers: Json
          batch_id: string | null
          correct_count: number
          created_at: string
          details: Json
          division: string
          evaluation_status: string
          exam_id: string
          guest_id: string
          id: string
          max_marks: number
          negative_total: number
          obtained: number
          percentage: number
          score: number
          started_at: string | null
          subject: string | null
          submitted_at: string
          time_taken_seconds: number | null
          total: number
          unanswered_count: number
          wrong_count: number
        }
        Insert: {
          answers?: Json
          batch_id?: string | null
          correct_count?: number
          created_at?: string
          details?: Json
          division?: string
          evaluation_status?: string
          exam_id: string
          guest_id: string
          id?: string
          max_marks?: number
          negative_total?: number
          obtained?: number
          percentage?: number
          score?: number
          started_at?: string | null
          subject?: string | null
          submitted_at?: string
          time_taken_seconds?: number | null
          total?: number
          unanswered_count?: number
          wrong_count?: number
        }
        Update: {
          answers?: Json
          batch_id?: string | null
          correct_count?: number
          created_at?: string
          details?: Json
          division?: string
          evaluation_status?: string
          exam_id?: string
          guest_id?: string
          id?: string
          max_marks?: number
          negative_total?: number
          obtained?: number
          percentage?: number
          score?: number
          started_at?: string | null
          subject?: string | null
          submitted_at?: string
          time_taken_seconds?: number | null
          total?: number
          unanswered_count?: number
          wrong_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "exam_results_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "exam_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_results_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_results_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_sessions: {
        Row: {
          answers: Json
          created_at: string
          current_index: number
          exam_id: string
          expires_at: string
          guest_id: string
          id: string
          started_at: string
          submitted: boolean
          updated_at: string
        }
        Insert: {
          answers?: Json
          created_at?: string
          current_index?: number
          exam_id: string
          expires_at?: string
          guest_id: string
          id?: string
          started_at?: string
          submitted?: boolean
          updated_at?: string
        }
        Update: {
          answers?: Json
          created_at?: string
          current_index?: number
          exam_id?: string
          expires_at?: string
          guest_id?: string
          id?: string
          started_at?: string
          submitted?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_sessions_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_sessions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      exams: {
        Row: {
          batch_id: string | null
          config: Json
          created_at: string
          delivered_at: string | null
          difficulty: string
          duration_minutes: number
          ends_at: string | null
          generation_error: string | null
          guest_id: string
          id: string
          klass: string | null
          language: string
          max_marks: number
          negative_marking: number
          question_type: string
          questions: Json
          scheduled_at: string | null
          sort_order: number
          started_at: string | null
          status: string
          subject: string | null
          timezone: string
          topic: string
          updated_at: string
        }
        Insert: {
          batch_id?: string | null
          config?: Json
          created_at?: string
          delivered_at?: string | null
          difficulty?: string
          duration_minutes?: number
          ends_at?: string | null
          generation_error?: string | null
          guest_id: string
          id?: string
          klass?: string | null
          language?: string
          max_marks?: number
          negative_marking?: number
          question_type?: string
          questions?: Json
          scheduled_at?: string | null
          sort_order?: number
          started_at?: string | null
          status?: string
          subject?: string | null
          timezone?: string
          topic?: string
          updated_at?: string
        }
        Update: {
          batch_id?: string | null
          config?: Json
          created_at?: string
          delivered_at?: string | null
          difficulty?: string
          duration_minutes?: number
          ends_at?: string | null
          generation_error?: string | null
          guest_id?: string
          id?: string
          klass?: string | null
          language?: string
          max_marks?: number
          negative_marking?: number
          question_type?: string
          questions?: Json
          scheduled_at?: string | null
          sort_order?: number
          started_at?: string | null
          status?: string
          subject?: string | null
          timezone?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exams_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "exam_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exams_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      gallery_images: {
        Row: {
          created_at: string
          file_size: number
          guest_id: string
          height: number
          id: string
          mime: string
          optimized: boolean
          original_name: string
          storage_path: string
          width: number
        }
        Insert: {
          created_at?: string
          file_size?: number
          guest_id: string
          height?: number
          id?: string
          mime: string
          optimized?: boolean
          original_name?: string
          storage_path: string
          width?: number
        }
        Update: {
          created_at?: string
          file_size?: number
          guest_id?: string
          height?: number
          id?: string
          mime?: string
          optimized?: boolean
          original_name?: string
          storage_path?: string
          width?: number
        }
        Relationships: [
          {
            foreignKeyName: "gallery_images_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      gallery_share_items: {
        Row: {
          created_at: string
          image_id: string
          share_id: string
        }
        Insert: {
          created_at?: string
          image_id: string
          share_id: string
        }
        Update: {
          created_at?: string
          image_id?: string
          share_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gallery_share_items_image_id_fkey"
            columns: ["image_id"]
            isOneToOne: false
            referencedRelation: "gallery_images"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gallery_share_items_share_id_fkey"
            columns: ["share_id"]
            isOneToOne: false
            referencedRelation: "gallery_shares"
            referencedColumns: ["id"]
          },
        ]
      }
      gallery_shares: {
        Row: {
          created_at: string
          guest_id: string
          id: string
          share_token: string
          signature: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          guest_id: string
          id?: string
          share_token: string
          signature?: string
          title?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          guest_id?: string
          id?: string
          share_token?: string
          signature?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gallery_shares_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      goals: {
        Row: {
          created_at: string
          details: string | null
          guest_id: string
          id: string
          progress: number
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          guest_id: string
          id?: string
          progress?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          details?: string | null
          guest_id?: string
          id?: string
          progress?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "goals_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      guests: {
        Row: {
          created_at: string
          id: string
          last_seen_at: string
        }
        Insert: {
          created_at?: string
          id: string
          last_seen_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_seen_at?: string
        }
        Relationships: []
      }
      lessons: {
        Row: {
          content: Json
          created_at: string
          guest_id: string
          id: string
          language: string
          level: string
          topic: string
        }
        Insert: {
          content?: Json
          created_at?: string
          guest_id: string
          id?: string
          language?: string
          level?: string
          topic?: string
        }
        Update: {
          content?: Json
          created_at?: string
          guest_id?: string
          id?: string
          language?: string
          level?: string
          topic?: string
        }
        Relationships: [
          {
            foreignKeyName: "lessons_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      master_event_attempt_questions: {
        Row: {
          answered_at: string | null
          answered_index: number | null
          attempt_id: string
          category: string
          correct_index: number
          difficulty: string
          explanation: string
          hint: string
          options: Json
          question: string
          question_number: number
          was_correct: boolean | null
        }
        Insert: {
          answered_at?: string | null
          answered_index?: number | null
          attempt_id: string
          category?: string
          correct_index: number
          difficulty?: string
          explanation?: string
          hint?: string
          options: Json
          question: string
          question_number: number
          was_correct?: boolean | null
        }
        Update: {
          answered_at?: string | null
          answered_index?: number | null
          attempt_id?: string
          category?: string
          correct_index?: number
          difficulty?: string
          explanation?: string
          hint?: string
          options?: Json
          question?: string
          question_number?: number
          was_correct?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "master_event_attempt_questions_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "master_event_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      master_event_attempts: {
        Row: {
          answer_timer_starts_at: string | null
          cleared_questions: number
          coin_reward: number
          correct_count: number
          created_at: string
          current_question: number
          deadline_at: string | null
          ended_at: string | null
          event_id: string
          game_state: string
          guest_id: string
          id: string
          idempotency_key: string | null
          language: string | null
          lifelines_used: Json
          question_count: number
          result: string
          score: number
          started_at: string
          status: string
          total_deadline_at: string | null
          wrong_count: number
        }
        Insert: {
          answer_timer_starts_at?: string | null
          cleared_questions?: number
          coin_reward?: number
          correct_count?: number
          created_at?: string
          current_question?: number
          deadline_at?: string | null
          ended_at?: string | null
          event_id: string
          game_state?: string
          guest_id: string
          id?: string
          idempotency_key?: string | null
          language?: string | null
          lifelines_used?: Json
          question_count: number
          result?: string
          score?: number
          started_at?: string
          status?: string
          total_deadline_at?: string | null
          wrong_count?: number
        }
        Update: {
          answer_timer_starts_at?: string | null
          cleared_questions?: number
          coin_reward?: number
          correct_count?: number
          created_at?: string
          current_question?: number
          deadline_at?: string | null
          ended_at?: string | null
          event_id?: string
          game_state?: string
          guest_id?: string
          id?: string
          idempotency_key?: string | null
          language?: string | null
          lifelines_used?: Json
          question_count?: number
          result?: string
          score?: number
          started_at?: string
          status?: string
          total_deadline_at?: string | null
          wrong_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "master_event_attempts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "master_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_event_attempts_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      master_event_audit: {
        Row: {
          action: string
          created_at: string
          detail: Json
          engine_version: string
          event_id: string | null
          from_status: string
          guest_id: string | null
          id: string
          reason: string
          to_status: string
        }
        Insert: {
          action: string
          created_at?: string
          detail?: Json
          engine_version?: string
          event_id?: string | null
          from_status?: string
          guest_id?: string | null
          id?: string
          reason?: string
          to_status?: string
        }
        Update: {
          action?: string
          created_at?: string
          detail?: Json
          engine_version?: string
          event_id?: string | null
          from_status?: string
          guest_id?: string | null
          id?: string
          reason?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_event_audit_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "master_events"
            referencedColumns: ["id"]
          },
        ]
      }
      master_event_results: {
        Row: {
          attempt_id: string | null
          coins_awarded: number
          correct_count: number
          created_at: string
          duration_ms: number
          event_id: string
          guest_id: string
          id: string
          is_winner: boolean
          outcome: string
          rank: number
          score: number
          source_ref: string
        }
        Insert: {
          attempt_id?: string | null
          coins_awarded?: number
          correct_count?: number
          created_at?: string
          duration_ms?: number
          event_id: string
          guest_id: string
          id?: string
          is_winner?: boolean
          outcome?: string
          rank?: number
          score?: number
          source_ref?: string
        }
        Update: {
          attempt_id?: string | null
          coins_awarded?: number
          correct_count?: number
          created_at?: string
          duration_ms?: number
          event_id?: string
          guest_id?: string
          id?: string
          is_winner?: boolean
          outcome?: string
          rank?: number
          score?: number
          source_ref?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_event_results_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "master_event_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_event_results_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "master_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_event_results_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      master_event_served_questions: {
        Row: {
          created_at: string
          event_id: string
          guest_id: string
          question: string
          question_hash: string
        }
        Insert: {
          created_at?: string
          event_id: string
          guest_id: string
          question?: string
          question_hash: string
        }
        Update: {
          created_at?: string
          event_id?: string
          guest_id?: string
          question?: string
          question_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "master_event_served_questions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "master_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_event_served_questions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      master_events: {
        Row: {
          achievement_config: Json
          answer_timer_seconds: number
          cancel_reason: string
          cancelled_at: string | null
          category: string
          certificate_config: Json
          code: string
          created_at: string
          created_by: string
          description: string
          difficulty: string
          end_time: string | null
          entry_config: Json
          event_type: string
          finalized_at: string | null
          gameplay_config: Json
          id: string
          language: string
          leaderboard_enabled: boolean
          lifeline_config: Json
          max_players: number
          min_players: number
          multiplayer_enabled: boolean
          name: string
          pre_timer_seconds: number
          published_at: string | null
          question_count: number
          question_source: string
          required_correct: number
          reward_config: Json
          source_event_id: string | null
          source_table: string
          start_time: string | null
          status: string
          timezone: string
          total_timer_seconds: number
          updated_at: string
        }
        Insert: {
          achievement_config?: Json
          answer_timer_seconds?: number
          cancel_reason?: string
          cancelled_at?: string | null
          category?: string
          certificate_config?: Json
          code: string
          created_at?: string
          created_by?: string
          description?: string
          difficulty?: string
          end_time?: string | null
          entry_config?: Json
          event_type: string
          finalized_at?: string | null
          gameplay_config?: Json
          id?: string
          language?: string
          leaderboard_enabled?: boolean
          lifeline_config?: Json
          max_players?: number
          min_players?: number
          multiplayer_enabled?: boolean
          name: string
          pre_timer_seconds?: number
          published_at?: string | null
          question_count: number
          question_source?: string
          required_correct?: number
          reward_config?: Json
          source_event_id?: string | null
          source_table?: string
          start_time?: string | null
          status?: string
          timezone?: string
          total_timer_seconds?: number
          updated_at?: string
        }
        Update: {
          achievement_config?: Json
          answer_timer_seconds?: number
          cancel_reason?: string
          cancelled_at?: string | null
          category?: string
          certificate_config?: Json
          code?: string
          created_at?: string
          created_by?: string
          description?: string
          difficulty?: string
          end_time?: string | null
          entry_config?: Json
          event_type?: string
          finalized_at?: string | null
          gameplay_config?: Json
          id?: string
          language?: string
          leaderboard_enabled?: boolean
          lifeline_config?: Json
          max_players?: number
          min_players?: number
          multiplayer_enabled?: boolean
          name?: string
          pre_timer_seconds?: number
          published_at?: string | null
          question_count?: number
          question_source?: string
          required_correct?: number
          reward_config?: Json
          source_event_id?: string | null
          source_table?: string
          start_time?: string | null
          status?: string
          timezone?: string
          total_timer_seconds?: number
          updated_at?: string
        }
        Relationships: []
      }
      mega_events: {
        Row: {
          category: string
          code: string
          created_at: string
          difficulty: string
          ends_at: string
          id: string
          max_players: number
          min_players: number
          multiplayer_enabled: boolean
          pass_cost: number
          pre_timer_seconds: number
          question_count: number
          question_seconds: number
          rewards: Json
          rules: Json
          scoring: Json
          solo_enabled: boolean
          solo_question_count: number
          solo_required_correct: number
          solo_total_seconds: number
          starts_at: string
          status: string
          timezone: string
          title: string
        }
        Insert: {
          category?: string
          code: string
          created_at?: string
          difficulty?: string
          ends_at?: string
          id?: string
          max_players?: number
          min_players?: number
          multiplayer_enabled?: boolean
          pass_cost?: number
          pre_timer_seconds?: number
          question_count?: number
          question_seconds?: number
          rewards?: Json
          rules?: Json
          scoring?: Json
          solo_enabled?: boolean
          solo_question_count?: number
          solo_required_correct?: number
          solo_total_seconds?: number
          starts_at?: string
          status?: string
          timezone?: string
          title?: string
        }
        Update: {
          category?: string
          code?: string
          created_at?: string
          difficulty?: string
          ends_at?: string
          id?: string
          max_players?: number
          min_players?: number
          multiplayer_enabled?: boolean
          pass_cost?: number
          pre_timer_seconds?: number
          question_count?: number
          question_seconds?: number
          rewards?: Json
          rules?: Json
          scoring?: Json
          solo_enabled?: boolean
          solo_question_count?: number
          solo_required_correct?: number
          solo_total_seconds?: number
          starts_at?: string
          status?: string
          timezone?: string
          title?: string
        }
        Relationships: []
      }
      mega_lobby_presence: {
        Row: {
          display_name: string
          event_id: string
          guest_id: string
          last_seen_at: string
          match_id: string | null
          state: string
        }
        Insert: {
          display_name?: string
          event_id: string
          guest_id: string
          last_seen_at?: string
          match_id?: string | null
          state?: string
        }
        Update: {
          display_name?: string
          event_id?: string
          guest_id?: string
          last_seen_at?: string
          match_id?: string | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "mega_lobby_presence_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "mega_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_lobby_presence_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: true
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_match_answers: {
        Row: {
          answered_at: string
          guest_id: string
          hint_shown: boolean
          is_correct: boolean
          match_id: string
          option_index: number | null
          question_number: number
          removed_options: Json | null
          response_ms: number
          score_delta: number
          skipped: boolean
        }
        Insert: {
          answered_at?: string
          guest_id: string
          hint_shown?: boolean
          is_correct?: boolean
          match_id: string
          option_index?: number | null
          question_number: number
          removed_options?: Json | null
          response_ms?: number
          score_delta?: number
          skipped?: boolean
        }
        Update: {
          answered_at?: string
          guest_id?: string
          hint_shown?: boolean
          is_correct?: boolean
          match_id?: string
          option_index?: number | null
          question_number?: number
          removed_options?: Json | null
          response_ms?: number
          score_delta?: number
          skipped?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "mega_match_answers_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_match_answers_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "mega_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_match_players: {
        Row: {
          correct_count: number
          display_name: string
          fifty_fifty_used: boolean
          guest_id: string
          hint_used: boolean
          is_host: boolean
          joined_at: string
          last_seen_at: string
          match_id: string
          rank: number | null
          score: number
          skip_used: boolean
          state: string
          total_response_ms: number
          unanswered_count: number
          wrong_count: number
        }
        Insert: {
          correct_count?: number
          display_name?: string
          fifty_fifty_used?: boolean
          guest_id: string
          hint_used?: boolean
          is_host?: boolean
          joined_at?: string
          last_seen_at?: string
          match_id: string
          rank?: number | null
          score?: number
          skip_used?: boolean
          state?: string
          total_response_ms?: number
          unanswered_count?: number
          wrong_count?: number
        }
        Update: {
          correct_count?: number
          display_name?: string
          fifty_fifty_used?: boolean
          guest_id?: string
          hint_used?: boolean
          is_host?: boolean
          joined_at?: string
          last_seen_at?: string
          match_id?: string
          rank?: number | null
          score?: number
          skip_used?: boolean
          state?: string
          total_response_ms?: number
          unanswered_count?: number
          wrong_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "mega_match_players_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_match_players_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "mega_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_match_questions: {
        Row: {
          category: string
          correct_index: number
          difficulty: string
          event_id: string
          explanation: string
          hint: string
          id: string
          match_id: string
          options: Json
          question: string
          question_number: number
          resolved: boolean
        }
        Insert: {
          category?: string
          correct_index: number
          difficulty?: string
          event_id: string
          explanation?: string
          hint?: string
          id?: string
          match_id: string
          options: Json
          question: string
          question_number: number
          resolved?: boolean
        }
        Update: {
          category?: string
          correct_index?: number
          difficulty?: string
          event_id?: string
          explanation?: string
          hint?: string
          id?: string
          match_id?: string
          options?: Json
          question?: string
          question_number?: number
          resolved?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "mega_match_questions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "mega_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_match_questions_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "mega_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_match_results: {
        Row: {
          created_at: string
          duration_ms: number
          ended_at: string | null
          event_id: string
          id: string
          match_id: string
          mode: string
          outcome: string
          question_count: number
          standings: Json
          started_at: string | null
          tie_break_reason: string
          winner_guest_id: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number
          ended_at?: string | null
          event_id: string
          id?: string
          match_id: string
          mode: string
          outcome?: string
          question_count: number
          standings?: Json
          started_at?: string | null
          tie_break_reason?: string
          winner_guest_id?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number
          ended_at?: string | null
          event_id?: string
          id?: string
          match_id?: string
          mode?: string
          outcome?: string
          question_count?: number
          standings?: Json
          started_at?: string | null
          tie_break_reason?: string
          winner_guest_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mega_match_results_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "mega_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_match_results_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: true
            referencedRelation: "mega_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_match_results_winner_guest_id_fkey"
            columns: ["winner_guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_matches: {
        Row: {
          answer_timer_starts_at: string | null
          created_at: string
          current_question: number
          ended_at: string | null
          event_id: string
          host_guest_id: string
          id: string
          mode: string
          presented_at: string | null
          question_count: number
          question_deadline_at: string | null
          question_seconds: number
          solo_deadline_at: string | null
          started_at: string | null
          status: string
          tie_break_reason: string
          winner_guest_id: string | null
        }
        Insert: {
          answer_timer_starts_at?: string | null
          created_at?: string
          current_question?: number
          ended_at?: string | null
          event_id: string
          host_guest_id: string
          id?: string
          mode?: string
          presented_at?: string | null
          question_count: number
          question_deadline_at?: string | null
          question_seconds?: number
          solo_deadline_at?: string | null
          started_at?: string | null
          status?: string
          tie_break_reason?: string
          winner_guest_id?: string | null
        }
        Update: {
          answer_timer_starts_at?: string | null
          created_at?: string
          current_question?: number
          ended_at?: string | null
          event_id?: string
          host_guest_id?: string
          id?: string
          mode?: string
          presented_at?: string | null
          question_count?: number
          question_deadline_at?: string | null
          question_seconds?: number
          solo_deadline_at?: string | null
          started_at?: string | null
          status?: string
          tie_break_reason?: string
          winner_guest_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mega_matches_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "mega_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_matches_host_guest_id_fkey"
            columns: ["host_guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_matches_winner_guest_id_fkey"
            columns: ["winner_guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_passes: {
        Row: {
          base_cost: number
          cost: number
          event_id: string
          guest_id: string
          id: string
          purchased_at: string
          status: string
          valid_from: string
          valid_until: string
        }
        Insert: {
          base_cost?: number
          cost?: number
          event_id: string
          guest_id: string
          id?: string
          purchased_at?: string
          status?: string
          valid_from?: string
          valid_until: string
        }
        Update: {
          base_cost?: number
          cost?: number
          event_id?: string
          guest_id?: string
          id?: string
          purchased_at?: string
          status?: string
          valid_from?: string
          valid_until?: string
        }
        Relationships: [
          {
            foreignKeyName: "mega_passes_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "mega_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_passes_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_player_results: {
        Row: {
          coins_awarded: number
          correct_count: number
          created_at: string
          event_id: string
          guest_id: string
          is_winner: boolean
          match_id: string
          mode: string
          outcome: string
          rank: number
          score: number
          total_response_ms: number
          unanswered_count: number
          wrong_count: number
        }
        Insert: {
          coins_awarded?: number
          correct_count?: number
          created_at?: string
          event_id: string
          guest_id: string
          is_winner?: boolean
          match_id: string
          mode: string
          outcome?: string
          rank?: number
          score?: number
          total_response_ms?: number
          unanswered_count?: number
          wrong_count?: number
        }
        Update: {
          coins_awarded?: number
          correct_count?: number
          created_at?: string
          event_id?: string
          guest_id?: string
          is_winner?: boolean
          match_id?: string
          mode?: string
          outcome?: string
          rank?: number
          score?: number
          total_response_ms?: number
          unanswered_count?: number
          wrong_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "mega_player_results_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "mega_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_player_results_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mega_player_results_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "mega_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      mega_served_questions: {
        Row: {
          guest_id: string
          last_served_at: string
          question_hash: string
        }
        Insert: {
          guest_id: string
          last_served_at?: string
          question_hash: string
        }
        Update: {
          guest_id?: string
          last_served_at?: string
          question_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "mega_served_questions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      memories: {
        Row: {
          content: string
          created_at: string
          guest_id: string
          id: string
          kind: string
          source: string
        }
        Insert: {
          content?: string
          created_at?: string
          guest_id: string
          id?: string
          kind?: string
          source?: string
        }
        Update: {
          content?: string
          created_at?: string
          guest_id?: string
          id?: string
          kind?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "memories_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          attachments: Json
          content: string
          conversation_id: string
          created_at: string
          guest_id: string
          id: string
          meta: Json
          role: string
        }
        Insert: {
          attachments?: Json
          content?: string
          conversation_id: string
          created_at?: string
          guest_id: string
          id?: string
          meta?: Json
          role: string
        }
        Update: {
          attachments?: Json
          content?: string
          conversation_id?: string
          created_at?: string
          guest_id?: string
          id?: string
          meta?: Json
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          content: string
          created_at: string
          guest_id: string
          id: string
          source: string
          title: string
          updated_at: string
        }
        Insert: {
          content?: string
          created_at?: string
          guest_id: string
          id?: string
          source?: string
          title?: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          guest_id?: string
          id?: string
          source?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          age: number | null
          avatar_mime: string | null
          avatar_ref: string | null
          avatar_updated_at: string | null
          board: string | null
          created_at: string
          education: string | null
          equipped_badge: string | null
          equipped_frame: string | null
          equipped_name_style: string | null
          guest_id: string
          interests: string | null
          klass: string | null
          language: string
          learning_preferences: string | null
          name: string | null
          updated_at: string
        }
        Insert: {
          age?: number | null
          avatar_mime?: string | null
          avatar_ref?: string | null
          avatar_updated_at?: string | null
          board?: string | null
          created_at?: string
          education?: string | null
          equipped_badge?: string | null
          equipped_frame?: string | null
          equipped_name_style?: string | null
          guest_id: string
          interests?: string | null
          klass?: string | null
          language?: string
          learning_preferences?: string | null
          name?: string | null
          updated_at?: string
        }
        Update: {
          age?: number | null
          avatar_mime?: string | null
          avatar_ref?: string | null
          avatar_updated_at?: string | null
          board?: string | null
          created_at?: string
          education?: string | null
          equipped_badge?: string | null
          equipped_frame?: string | null
          equipped_name_style?: string | null
          guest_id?: string
          interests?: string | null
          klass?: string | null
          language?: string
          learning_preferences?: string | null
          name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_equipped_badge_fk"
            columns: ["equipped_badge"]
            isOneToOne: false
            referencedRelation: "ustad_shop_items"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "profiles_equipped_frame_fk"
            columns: ["equipped_frame"]
            isOneToOne: false
            referencedRelation: "ustad_shop_items"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "profiles_equipped_name_style_fk"
            columns: ["equipped_name_style"]
            isOneToOne: false
            referencedRelation: "ustad_shop_items"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "profiles_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: true
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      reminders: {
        Row: {
          created_at: string
          done: boolean
          due_at: string
          guest_id: string
          id: string
          kind: string
          note: string | null
          notified_at: string | null
          payload: Json
          repeat_rule: string
          title: string
        }
        Insert: {
          created_at?: string
          done?: boolean
          due_at?: string
          guest_id: string
          id?: string
          kind?: string
          note?: string | null
          notified_at?: string | null
          payload?: Json
          repeat_rule?: string
          title?: string
        }
        Update: {
          created_at?: string
          done?: boolean
          due_at?: string
          guest_id?: string
          id?: string
          kind?: string
          note?: string | null
          notified_at?: string | null
          payload?: Json
          repeat_rule?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminders_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_idempotency: {
        Row: {
          created_at: string
          guest_id: string
          id: string
          kind: string
          result: Json
        }
        Insert: {
          created_at?: string
          guest_id: string
          id?: string
          kind: string
          result?: Json
        }
        Update: {
          created_at?: string
          guest_id?: string
          id?: string
          kind?: string
          result?: Json
        }
        Relationships: [
          {
            foreignKeyName: "request_idempotency_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          auto_speak: boolean
          data_saver: boolean
          extras: Json
          guest_id: string
          language: string
          theme: string
          timezone: string | null
          updated_at: string
          voice: Json
          web_search: boolean
        }
        Insert: {
          auto_speak?: boolean
          data_saver?: boolean
          extras?: Json
          guest_id: string
          language?: string
          theme?: string
          timezone?: string | null
          updated_at?: string
          voice?: Json
          web_search?: boolean
        }
        Update: {
          auto_speak?: boolean
          data_saver?: boolean
          extras?: Json
          guest_id?: string
          language?: string
          theme?: string
          timezone?: string | null
          updated_at?: string
          voice?: Json
          web_search?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "settings_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: true
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_attempts: {
        Row: {
          achievement_id: string | null
          attempt_date: string
          certificate_id: string
          certificate_url: string
          coins_awarded: number
          completed_at: string | null
          correct_count: number
          created_at: string
          current_index: number
          cycle_end: string | null
          cycle_id: string
          cycle_start: string | null
          entry_amount: number
          entry_txn_id: string
          guest_id: string
          id: string
          kind: string
          language: string
          result: string
          reward_issued: boolean
          reward_txn_id: string
          score: number
          status: string
          ticket_consumed: boolean
          total_questions: number
          updated_at: string
          wrong_count: number
        }
        Insert: {
          achievement_id?: string | null
          attempt_date: string
          certificate_id?: string
          certificate_url?: string
          coins_awarded?: number
          completed_at?: string | null
          correct_count?: number
          created_at?: string
          current_index?: number
          cycle_end?: string | null
          cycle_id: string
          cycle_start?: string | null
          entry_amount?: number
          entry_txn_id?: string
          guest_id: string
          id?: string
          kind: string
          language?: string
          result?: string
          reward_issued?: boolean
          reward_txn_id?: string
          score?: number
          status?: string
          ticket_consumed?: boolean
          total_questions?: number
          updated_at?: string
          wrong_count?: number
        }
        Update: {
          achievement_id?: string | null
          attempt_date?: string
          certificate_id?: string
          certificate_url?: string
          coins_awarded?: number
          completed_at?: string | null
          correct_count?: number
          created_at?: string
          current_index?: number
          cycle_end?: string | null
          cycle_id?: string
          cycle_start?: string | null
          entry_amount?: number
          entry_txn_id?: string
          guest_id?: string
          id?: string
          kind?: string
          language?: string
          result?: string
          reward_issued?: boolean
          reward_txn_id?: string
          score?: number
          status?: string
          ticket_consumed?: boolean
          total_questions?: number
          updated_at?: string
          wrong_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "tournament_attempts_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_questions: {
        Row: {
          answered_at: string | null
          attempt_id: string
          category: string
          correct_index: number
          created_at: string
          difficulty: string
          explanation: string
          id: string
          is_correct: boolean | null
          options: Json
          payload: Json
          position: number
          prompt: string
          selected_index: number | null
          solution: string
        }
        Insert: {
          answered_at?: string | null
          attempt_id: string
          category?: string
          correct_index?: number
          created_at?: string
          difficulty?: string
          explanation?: string
          id?: string
          is_correct?: boolean | null
          options?: Json
          payload?: Json
          position: number
          prompt?: string
          selected_index?: number | null
          solution?: string
        }
        Update: {
          answered_at?: string | null
          attempt_id?: string
          category?: string
          correct_index?: number
          created_at?: string
          difficulty?: string
          explanation?: string
          id?: string
          is_correct?: boolean | null
          options?: Json
          payload?: Json
          position?: number
          prompt?: string
          selected_index?: number | null
          solution?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_questions_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "tournament_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      trophy_designs: {
        Row: {
          active: boolean
          code: string
          created_at: string
          event_id: string | null
          event_kind: string
          id: string
          theme: Json
          title: string
          trophy_type: string
          version: number
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          event_id?: string | null
          event_kind?: string
          id?: string
          theme?: Json
          title: string
          trophy_type: string
          version?: number
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          event_id?: string | null
          event_kind?: string
          id?: string
          theme?: Json
          title?: string
          trophy_type?: string
          version?: number
        }
        Relationships: []
      }
      ustad_achievements: {
        Row: {
          awarded_at: string
          created_at: string
          event_id: string | null
          event_kind: string
          guest_id: string
          id: string
          level: number
          match_id: string | null
          metadata: Json
          revoked_at: string | null
          revoked_reason: string
          source: string
          title: string
          type: string
          verification_status: string
        }
        Insert: {
          awarded_at?: string
          created_at?: string
          event_id?: string | null
          event_kind?: string
          guest_id: string
          id?: string
          level?: number
          match_id?: string | null
          metadata?: Json
          revoked_at?: string | null
          revoked_reason?: string
          source?: string
          title: string
          type: string
          verification_status?: string
        }
        Update: {
          awarded_at?: string
          created_at?: string
          event_id?: string | null
          event_kind?: string
          guest_id?: string
          id?: string
          level?: number
          match_id?: string | null
          metadata?: Json
          revoked_at?: string | null
          revoked_reason?: string
          source?: string
          title?: string
          type?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_achievements_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_certificates: {
        Row: {
          achievement_id: string | null
          certificate_id: string
          certificate_type: string
          claim_count: number
          claimed_at: string | null
          created_at: string
          event_id: string | null
          guest_id: string
          id: string
          integrity_hash: string
          issued_at: string
          match_id: string | null
          metadata: Json
          reference_key: string | null
          revoked_at: string | null
          revoked_reason: string
          template_code: string
          template_version: number
          updated_at: string
          verification_status: string
          verification_token: string
        }
        Insert: {
          achievement_id?: string | null
          certificate_id: string
          certificate_type: string
          claim_count?: number
          claimed_at?: string | null
          created_at?: string
          event_id?: string | null
          guest_id: string
          id?: string
          integrity_hash?: string
          issued_at?: string
          match_id?: string | null
          metadata?: Json
          reference_key?: string | null
          revoked_at?: string | null
          revoked_reason?: string
          template_code?: string
          template_version?: number
          updated_at?: string
          verification_status?: string
          verification_token: string
        }
        Update: {
          achievement_id?: string | null
          certificate_id?: string
          certificate_type?: string
          claim_count?: number
          claimed_at?: string | null
          created_at?: string
          event_id?: string | null
          guest_id?: string
          id?: string
          integrity_hash?: string
          issued_at?: string
          match_id?: string | null
          metadata?: Json
          reference_key?: string | null
          revoked_at?: string | null
          revoked_reason?: string
          template_code?: string
          template_version?: number
          updated_at?: string
          verification_status?: string
          verification_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_certificates_achievement_id_fkey"
            columns: ["achievement_id"]
            isOneToOne: false
            referencedRelation: "ustad_achievements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ustad_certificates_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_coin_ledger: {
        Row: {
          balance_after: number | null
          balance_before: number | null
          coins: number
          created_at: string
          direction: string | null
          guest_id: string
          id: string
          note: string
          ref_id: string
          source: string
          status: string
          tx_type: string
        }
        Insert: {
          balance_after?: number | null
          balance_before?: number | null
          coins?: number
          created_at?: string
          direction?: string | null
          guest_id: string
          id?: string
          note?: string
          ref_id: string
          source: string
          status?: string
          tx_type?: string
        }
        Update: {
          balance_after?: number | null
          balance_before?: number | null
          coins?: number
          created_at?: string
          direction?: string | null
          guest_id?: string
          id?: string
          note?: string
          ref_id?: string
          source?: string
          status?: string
          tx_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_coin_ledger_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_coin_offer_purchases: {
        Row: {
          base_price: number
          created_at: string
          discount_amount: number
          discount_pct: number
          final_price: number
          guest_id: string
          id: string
          item_id: string
          item_kind: string
          ref_id: string
          source: string
          weekly_offer_id: string
        }
        Insert: {
          base_price?: number
          created_at?: string
          discount_amount?: number
          discount_pct?: number
          final_price?: number
          guest_id: string
          id?: string
          item_id?: string
          item_kind?: string
          ref_id?: string
          source?: string
          weekly_offer_id: string
        }
        Update: {
          base_price?: number
          created_at?: string
          discount_amount?: number
          discount_pct?: number
          final_price?: number
          guest_id?: string
          id?: string
          item_id?: string
          item_kind?: string
          ref_id?: string
          source?: string
          weekly_offer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_coin_offer_purchases_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_coin_offers: {
        Row: {
          coins_deducted: number
          created_at: string
          cycle_end: string
          cycle_start: string
          discount_pct: number
          duration_minutes: number
          end_iso: string
          id: string
          offer_day_offset: number
          purchases_count: number
          start_iso: string
          status: string
          updated_at: string
          weekly_offer_id: string
        }
        Insert: {
          coins_deducted?: number
          created_at?: string
          cycle_end: string
          cycle_start: string
          discount_pct: number
          duration_minutes: number
          end_iso: string
          id?: string
          offer_day_offset?: number
          purchases_count?: number
          start_iso: string
          status?: string
          updated_at?: string
          weekly_offer_id: string
        }
        Update: {
          coins_deducted?: number
          created_at?: string
          cycle_end?: string
          cycle_start?: string
          discount_pct?: number
          duration_minutes?: number
          end_iso?: string
          id?: string
          offer_day_offset?: number
          purchases_count?: number
          start_iso?: string
          status?: string
          updated_at?: string
          weekly_offer_id?: string
        }
        Relationships: []
      }
      ustad_event_reminder_log: {
        Row: {
          event_id: string
          fired_at: string
          guest_id: string
          id: string
          reminder_kind: string
        }
        Insert: {
          event_id: string
          fired_at?: string
          guest_id: string
          id?: string
          reminder_kind: string
        }
        Update: {
          event_id?: string
          fired_at?: string
          guest_id?: string
          id?: string
          reminder_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_event_reminder_log_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "master_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ustad_event_reminder_log_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_notifications: {
        Row: {
          action_path: string
          category: string
          created_at: string
          dedupe_key: string
          deleted_at: string | null
          guest_id: string
          id: string
          is_read: boolean
          language: string
          message: string
          metadata: Json
          read_at: string | null
          reference_id: string
          reference_type: string
          title: string
          type: string
          user_id: string | null
        }
        Insert: {
          action_path?: string
          category?: string
          created_at?: string
          dedupe_key: string
          deleted_at?: string | null
          guest_id: string
          id?: string
          is_read?: boolean
          language?: string
          message?: string
          metadata?: Json
          read_at?: string | null
          reference_id?: string
          reference_type?: string
          title: string
          type: string
          user_id?: string | null
        }
        Update: {
          action_path?: string
          category?: string
          created_at?: string
          dedupe_key?: string
          deleted_at?: string | null
          guest_id?: string
          id?: string
          is_read?: boolean
          language?: string
          message?: string
          metadata?: Json
          read_at?: string | null
          reference_id?: string
          reference_type?: string
          title?: string
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ustad_notifications_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_purchases: {
        Row: {
          guest_id: string
          item_id: string
          ownership_status: string
          price_paid: number
          purchase_id: string
          purchased_at: string
          transaction_id: string | null
        }
        Insert: {
          guest_id: string
          item_id: string
          ownership_status?: string
          price_paid: number
          purchase_id?: string
          purchased_at?: string
          transaction_id?: string | null
        }
        Update: {
          guest_id?: string
          item_id?: string
          ownership_status?: string
          price_paid?: number
          purchase_id?: string
          purchased_at?: string
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ustad_purchases_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ustad_purchases_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "ustad_shop_items"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "ustad_purchases_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "ustad_coin_ledger"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_rank_awards: {
        Row: {
          category: string
          certificate_id: string | null
          coins: number
          created_at: string
          cup_awarded: boolean
          cup_count: number
          cycle_end: string
          cycle_start: string
          guest_id: string
          id: string
          profile_name: string
          rank: number
          status: string
          transaction_id: string | null
          updated_at: string
        }
        Insert: {
          category: string
          certificate_id?: string | null
          coins?: number
          created_at?: string
          cup_awarded?: boolean
          cup_count?: number
          cycle_end: string
          cycle_start: string
          guest_id: string
          id?: string
          profile_name?: string
          rank: number
          status?: string
          transaction_id?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          certificate_id?: string | null
          coins?: number
          created_at?: string
          cup_awarded?: boolean
          cup_count?: number
          cycle_end?: string
          cycle_start?: string
          guest_id?: string
          id?: string
          profile_name?: string
          rank?: number
          status?: string
          transaction_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ustad_rank_cycles: {
        Row: {
          created_at: string
          cycle_end: string
          cycle_start: string
          settled_at: string
          summary: Json
        }
        Insert: {
          created_at?: string
          cycle_end: string
          cycle_start: string
          settled_at?: string
          summary?: Json
        }
        Update: {
          created_at?: string
          cycle_end?: string
          cycle_start?: string
          settled_at?: string
          summary?: Json
        }
        Relationships: []
      }
      ustad_shop_items: {
        Row: {
          asset_reference: string
          availability: string
          category: string
          created_at: string
          description: string
          item_id: string
          name: string
          ownership_type: string
          price_coins: number
          sort_order: number
          status: string
          updated_at: string
        }
        Insert: {
          asset_reference?: string
          availability?: string
          category: string
          created_at?: string
          description?: string
          item_id: string
          name: string
          ownership_type?: string
          price_coins: number
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Update: {
          asset_reference?: string
          availability?: string
          category?: string
          created_at?: string
          description?: string
          item_id?: string
          name?: string
          ownership_type?: string
          price_coins?: number
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      ustad_tickets: {
        Row: {
          created_at: string
          god_tickets: number
          guest_id: string
          lifetime_purchased: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          god_tickets?: number
          guest_id: string
          lifetime_purchased?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          god_tickets?: number
          guest_id?: string
          lifetime_purchased?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_tickets_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: true
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_trophies: {
        Row: {
          achievement_id: string
          created_at: string
          design_code: string
          design_id: string | null
          design_version: number
          engraving: Json
          event_id: string | null
          guest_id: string
          id: string
          image_reference: string | null
          image_status: string
          match_id: string | null
          type: string
        }
        Insert: {
          achievement_id: string
          created_at?: string
          design_code?: string
          design_id?: string | null
          design_version?: number
          engraving?: Json
          event_id?: string | null
          guest_id: string
          id?: string
          image_reference?: string | null
          image_status?: string
          match_id?: string | null
          type: string
        }
        Update: {
          achievement_id?: string
          created_at?: string
          design_code?: string
          design_id?: string | null
          design_version?: number
          engraving?: Json
          event_id?: string | null
          guest_id?: string
          id?: string
          image_reference?: string | null
          image_status?: string
          match_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_trophies_achievement_id_fkey"
            columns: ["achievement_id"]
            isOneToOne: true
            referencedRelation: "ustad_achievements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ustad_trophies_design_id_fkey"
            columns: ["design_id"]
            isOneToOne: false
            referencedRelation: "trophy_designs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ustad_trophies_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      ustad_wallets: {
        Row: {
          created_at: string
          current_balance: number
          guest_id: string
          lifetime_earned: number
          lifetime_spent: number
          updated_at: string
          wallet_id: string
        }
        Insert: {
          created_at?: string
          current_balance?: number
          guest_id: string
          lifetime_earned?: number
          lifetime_spent?: number
          updated_at?: string
          wallet_id?: string
        }
        Update: {
          created_at?: string
          current_balance?: number
          guest_id?: string
          lifetime_earned?: number
          lifetime_spent?: number
          updated_at?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ustad_wallets_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: true
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ustad_coin_apply: {
        Args: {
          p_amount: number
          p_guest_id: string
          p_note?: string
          p_ref_id: string
          p_source: string
          p_type?: string
        }
        Returns: {
          applied: boolean
          balance_after: number
          balance_before: number
          transaction_id: string
        }[]
      }
      ustad_shop_buy: {
        Args: {
          p_discount_pct?: number
          p_final_price?: number
          p_guest_id: string
          p_item_id: string
          p_offer_base_price?: number
          p_offer_weekly_id?: string
        }
        Returns: {
          already_owned: boolean
          balance_after: number
          price_paid: number
          purchase_id: string
          transaction_id: string
        }[]
      }
      ustad_ticket_consume: { Args: { p_guest_id: string }; Returns: number }
      ustad_ticket_grant: {
        Args: { p_amount: number; p_guest_id: string }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
