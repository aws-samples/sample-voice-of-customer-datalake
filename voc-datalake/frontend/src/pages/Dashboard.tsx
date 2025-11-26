import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar } from 'recharts'
import { MessageSquare, TrendingUp, AlertTriangle, Users, Zap } from 'lucide-react'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import MetricCard from '../components/MetricCard'
import FeedbackCard from '../components/FeedbackCard'
import SocialFeed from '../components/SocialFeed'

const COLORS = ['#22c55e', '#6b7280', '#ef4444', '#eab308']

export default function Dashboard() {
  const { timeRange, customDateRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const isConfigured = !!config.apiEndpoint

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['summary', days],
    queryFn: () => api.getSummary(days),
    enabled: isConfigured,
  })

  const { data: sentiment } = useQuery({
    queryKey: ['sentiment', days],
    queryFn: () => api.getSentiment(days),
    enabled: isConfigured,
  })

  const { data: categories } = useQuery({
    queryKey: ['categories', days],
    queryFn: () => api.getCategories(days),
    enabled: isConfigured,
  })

  const { data: sources } = useQuery({
    queryKey: ['sources', days],
    queryFn: () => api.getSources(days),
    enabled: isConfigured,
  })

  const { data: urgentFeedback } = useQuery({
    queryKey: ['urgent', days],
    queryFn: () => api.getUrgentFeedback({ days, limit: 5 }),
    enabled: isConfigured,
  })

  if (!isConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-center max-w-md">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Welcome to VoC Analytics</h2>
          <p className="text-gray-600 mb-6">
            Configure your API endpoint and brand settings to start analyzing customer feedback.
          </p>
          <a href="/settings" className="btn btn-primary">
            Go to Settings
          </a>
        </div>
      </div>
    )
  }

  if (summaryLoading) {
    return <div className="flex items-center justify-center h-full">Loading...</div>
  }

  const sentimentPieData = sentiment ? [
    { name: 'Positive', value: sentiment.breakdown.positive || 0 },
    { name: 'Neutral', value: sentiment.breakdown.neutral || 0 },
    { name: 'Negative', value: sentiment.breakdown.negative || 0 },
    { name: 'Mixed', value: sentiment.breakdown.mixed || 0 },
  ].filter(d => d.value > 0) : []

  const categoryBarData = categories ? 
    Object.entries(categories.categories)
      .slice(0, 8)
      .map(([name, value]) => ({ name, value })) : []

  const sourceBarData = sources ?
    Object.entries(sources.sources)
      .map(([name, value]) => ({ name: name.replace('_', ' '), value })) : []

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Feedback"
          value={summary?.total_feedback.toLocaleString() || 0}
          icon={<MessageSquare size={24} />}
          color="blue"
        />
        <MetricCard
          title="Avg Sentiment"
          value={summary ? Number(summary.avg_sentiment).toFixed(2) : '0.00'}
          icon={<TrendingUp size={24} />}
          color={summary && Number(summary.avg_sentiment) > 0 ? 'green' : 'red'}
          trend={summary && Number(summary.avg_sentiment) > 0 ? 'up' : 'down'}
        />
        <MetricCard
          title="Urgent Issues"
          value={summary?.urgent_count || 0}
          icon={<AlertTriangle size={24} />}
          color="orange"
        />
        <MetricCard
          title="Sources Active"
          value={Object.keys(sources?.sources || {}).length}
          icon={<Users size={24} />}
          color="gray"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trend Chart */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Feedback Volume & Sentiment Trend</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={summary?.daily_totals || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Sentiment Pie */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Sentiment Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={sentimentPieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
                label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
              >
                {sentimentPieData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Categories and Sources */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Categories */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Top Issue Categories</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={categoryBarData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12 }} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} width={100} />
              <Tooltip />
              <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Sources */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Feedback by Source</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={sourceBarData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Social Feed and Urgent Issues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Social Media Feed */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="text-blue-500" size={20} />
            Live Social Feed
          </h3>
          <SocialFeed limit={8} showFilters={true} />
        </div>

        {/* Urgent Feedback */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <AlertTriangle className="text-orange-500" size={20} />
            Urgent Issues ({urgentFeedback?.count || 0})
          </h3>
          {urgentFeedback && urgentFeedback.items.length > 0 ? (
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {urgentFeedback.items.slice(0, 6).map((item) => (
                <FeedbackCard key={item.feedback_id} feedback={item} compact />
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              No urgent issues - great job! 🎉
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
