import type { Question } from '../types.js';
import type { AggregatedResults } from './results.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

type GenerateSummaryParams = {
    question: Question;
    aggregates: AggregatedResults;
};

function formatChoicesSummary(question: Question, aggregates: AggregatedResults) {
    if (!question.choices?.length) {
        return 'Aucune option disponible.';
    }

    const countsByChoice = new Map(
        aggregates.byChoice.map(({ choiceId, count }) => [choiceId ?? 'none', count] as const)
    );

    return question.choices
        .map((choice) => {
            const count = countsByChoice.get(choice.id) ?? 0;
            return `${choice.text.trim()} : ${count}`;
        })
        .join('\n');
}

function formatTextSummary(aggregates: AggregatedResults) {
    if (!aggregates.texts.length) {
        return 'Aucune réponse libre saisie.';
    }

    const samples = aggregates.texts
        .map(({ text }) => text?.trim())
        .filter((text): text is string => Boolean(text))
        .slice(0, 5);

    if (!samples.length) {
        return 'Aucune réponse libre exploitable.';
    }

    return `Exemples de réponses libres (${samples.length} sur ${aggregates.texts.length}) : ${samples.join(
        ' | '
    )}`;
}

function formatNumberSummary(aggregates: AggregatedResults) {
    const values = aggregates.numbers.flatMap(({ values }) => values ?? []);
    if (!values.length) {
        return 'Pas de réponses numériques collectées.';
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((total, value) => total + value, 0) / values.length;

    return `Réponses numériques : moyenne ${avg.toFixed(2)}, minimum ${min}, maximum ${max}.`;
}

function buildPrompt({ question, aggregates }: GenerateSummaryParams) {
    const totalVotes = aggregates.totals?.[0]?.total ?? 0;
    const choiceSummary = formatChoicesSummary(question, aggregates);
    const textSummary = formatTextSummary(aggregates);
    const numberSummary = formatNumberSummary(aggregates);

    return `Tu es un assistant qui analyse les résultats d'un sondage en direct.
Formule une interprétation synthétique en une ou deux phrases, en utilisant si possible la même langue que la question.

Question : ${question.question}
Total de réponses : ${totalVotes}

Répartition des choix :
${choiceSummary}

${textSummary}
${numberSummary}`;
}

export async function generateResultsInterpretation(
    params: GenerateSummaryParams
): Promise<string | null> {
    if (!OPENAI_API_KEY) {
        console.warn('OPENAI_API_KEY is not set. Skipping AI interpretation.');
        return null;
    }

    try {
        const prompt = buildPrompt(params);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                temperature: 0.2,
                max_tokens: 200,
                messages: [
                    {
                        role: 'system',
                        content:
                            "Tu analyses des réponses de sondage pour des animateurs et tu fournis des observations concises."
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });

        if (!response.ok) {
            console.error('Failed to generate AI interpretation', await response.text());
            return null;
        }

        const data: any = await response.json();
        const content: string | undefined = data?.choices?.[0]?.message?.content;
        return content?.trim() ?? null;
    } catch (error) {
        console.error('Error while requesting AI interpretation', error);
        return null;
    }
}
