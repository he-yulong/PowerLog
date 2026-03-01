from django.urls import path
from .views import TrainingEntryListCreateView

urlpatterns = [
    path('entries/', TrainingEntryListCreateView.as_view(), name='training-entry-list-create'),
]
