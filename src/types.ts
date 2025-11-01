export type QuestionRevealStatisticsType = 'bar_chart' | 'pie_chart' | 'word_cloud' | 'none';

export interface QuestionMedia {
    type: 'image' | 'video' | 'audio';
    url: string;
}

export interface QuestionChoiceConstraints {
    minLength?: number;
    maxLength?: number;
    minValue?: number;
    maxValue?: number;
}

export interface QuestionChoice {
    id: string;
    input: 'choice' | 'text' | 'number';
    text: string;
    constraints?: QuestionChoiceConstraints;
    isCorrect: boolean;
}

export interface QuestionRevealExplanation {
    showExplanation: boolean;
    explanationText?: string;
    explanationAi?: boolean;
}

export interface QuestionRevealStatistics {
    showStatistics: boolean;
    statisticsType?: QuestionRevealStatisticsType;
    showPercentages?: boolean;
    minVotesToDisplay?: number;
}

export interface QuestionReveal {
    mode: 'immediate' | 'after_timer' | 'manual';
    showCorrectAnswers: boolean;
    statistics: QuestionRevealStatistics;
    explanation: QuestionRevealExplanation;
}

export interface QuestionDuration {
    type: 'timer' | 'manual';
    duration?: number;
}

export interface QuestionScore {
    enabled: boolean;
    points?: number;
    negativePoints?: number;
}

export interface Question {
    id: string;
    kind: 'multiple_choice' | 'single_choice' | 'true_false' | 'poll';
    allowMultiple: boolean;

    duration: QuestionDuration;
    question: string;
    description?: string;
    media?: QuestionMedia[];

    choices: QuestionChoice[];

    score: QuestionScore;
    reveal?: QuestionReveal;
}

export interface LiveSettings {
    enabled: boolean;
    sessionCode?: string;
    hostSessionCode?: string;
    lobbyEnabled?: boolean;
    interQuestionCountdownSec?: number;
    autoAdvanceAfterRevealSec?: number;
}

export type LivePhase = 'asking' | 'revealing';

export interface FormSection {
    id: string;
    title?: string;
    description?: string;
    items: Question[];
}

export interface BranchRule {
    id: string;
    action:
    | { type: 'goto_section'; sectionId: string }
    | { type: 'goto_item'; itemId: string }
    | { type: 'end_form' };
    priority?: number;
}

export interface FormParticipant {
    id: string;
    role: 'admin' | 'viewer';
}

export interface Form {
    id: string;
    title: string;
    description?: string;

    live?: LiveSettings;
    participants?: FormParticipant[];

    sections?: FormSection[];
    branchRules?: BranchRule[];
}

export type ClientToServerEvents = {
    'join_form': (payload: { formId: string; role: 'admin' | 'viewer'; sessionCode?: string; hostSessionCode?: string; participantId?: string; displayName?: string }) => void;
    'get_state': (payload: { formId: string }) => void;
    'submit_answer': (payload: { formId: string; questionId: string; value: { choiceIds?: string[]; text?: string; number?: number } }) => void;

    'admin:set_question': (payload: { formId: string; sectionIndex: number; itemIndex: number }) => void;
    'admin:start_question': (payload: { formId: string }) => void;
    'admin:next': (payload: { formId: string }) => void;
    'admin:reveal': (payload: { formId: string; show: boolean }) => void;
    'admin:lock': (payload: { formId: string; locked: boolean }) => void;
};

export type ServerToClientEvents = {
    'state': (state: LiveState) => void;
    'results': (payload: { questionId: string; aggregates: any }) => void;
    'admin:dashboard': (payload: {
        formId: string;
        sectionIndex: number;
        itemIndex: number;
        question: Question | null;
        aggregates: any | null;
    }) => void;

    'admin:results': (payload: {
        questionId: string;
        aggregates: any;
        interpretation?: string | null;
    }) => void;

    'admin:explanation': (payload: { questionId: string; explanation: string }) => void;

    'error_msg': (payload: { code: string; message: string }) => void;
};

export interface LiveState {
    formId: string;
    sectionIndex: number;
    itemIndex: number;
    locked: boolean;
    revealResults: boolean;
    timer?: { remaining?: number; total?: number } | null;
    phase?: LivePhase;
}
